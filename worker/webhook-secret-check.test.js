import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { checkWebhookSecrets, webhookSecretCardId } from './lib/webhook-secret-check.js';

// #1793. Own file (own D1 isolate): it writes control_room_tasks rows.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const card = (id) => env.DB.prepare('SELECT * FROM control_room_tasks WHERE task_id = ?').bind(webhookSecretCardId(id)).first();
const count = async (id) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM control_room_tasks WHERE task_id = ?').bind(webhookSecretCardId(id)).first()).n;

describe('checkWebhookSecrets (#1793)', () => {
  it('raises nothing when no provider is configured (dev/test environments)', async () => {
    await checkWebhookSecrets({ DB: env.DB });
    expect(await count('stripe')).toBe(0);
    expect(await count('didit')).toBe(0);
    expect(await count('tripo')).toBe(0);
  });

  it('raises one owner-waiting card, once, when a provider is configured without its webhook secret', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const misconfigured = { DB: env.DB, STRIPE_SECRET_KEY: 'sk_test_x' };
    await checkWebhookSecrets(misconfigured);
    await checkWebhookSecrets(misconfigured);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK SECRET MISSING: STRIPE_WEBHOOK_SECRET'));
    spy.mockRestore();
    expect(await count('stripe')).toBe(1);
    const row = await card('stripe');
    expect(row.status).toBe('queued');
    expect(row.waiting_on).toBe('owner');
    expect(row.note).toContain('STRIPE_WEBHOOK_SECRET');
    expect(row.title).toContain('[owner action needed]');
    expect(await count('didit')).toBe(0);
  });

  it('needs every Didit credential before treating it as in use, and covers Tripo', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await checkWebhookSecrets({ DB: env.DB, DIDIT_API_KEY: 'k' });
    expect(await count('didit')).toBe(0);
    await checkWebhookSecrets({ DB: env.DB, DIDIT_API_KEY: 'k', DIDIT_WORKFLOW_ID: 'w', TRIPO_API_KEY: 't' });
    vi.restoreAllMocks();
    expect(await count('didit')).toBe(1);
    expect(await count('tripo')).toBe(1);
  });

  it('resolves its own card once the secret is set, and stays quiet afterwards', async () => {
    await checkWebhookSecrets({ DB: env.DB, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' });
    const row = await card('stripe');
    expect(row.status).toBe('done');
    expect(row.waiting_on).toBeNull();
    await checkWebhookSecrets({ DB: env.DB, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' });
    expect(await count('stripe')).toBe(1);
  });

  it('does not re-open a card the owner already marked done', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.DB.prepare("UPDATE control_room_tasks SET status = 'done' WHERE task_id = ?").bind(webhookSecretCardId('tripo')).run();
    await checkWebhookSecrets({ DB: env.DB, TRIPO_API_KEY: 't' });
    vi.restoreAllMocks();
    expect((await card('tripo')).status).toBe('done');
  });
});
