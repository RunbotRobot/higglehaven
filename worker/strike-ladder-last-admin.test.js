// #3085: the strike ladder must not suspend the last operational admin --
// the same "never lock the project out of its own admin tools" invariant
// handleSuspendAccount enforces (#2268), per AGENTS.md's "Parity across
// sibling surfaces". The strike itself still counts; the blocked suspension
// is logged and reported to the admin instead of being silently skipped.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, grantAdminTo, signupBuilder, signupSeller } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function sellerWithListing(prefix) {
  const seller = await signupSeller(`${prefix}-seller`);
  const templateId = `${prefix}-template`;
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      sellerId: seller.sellerId,
      name: `Ladder fixture ${prefix}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
    }),
  }));
  expect(created.response.status).toBe(201);
  return { seller, templateId };
}

async function flagAndApproveSevere(prefix, templateId, adminSession) {
  const flagger = await signupBuilder(`${prefix}-flagger`);
  await api(`/catalog/${templateId}/flags`, flagger.session({ method: 'POST', body: JSON.stringify({}) }));
  return api(`/catalog/${templateId}/flags/resolve`, adminSession({
    method: 'POST',
    body: JSON.stringify({ action: 'approve', severe: true }),
  }));
}

async function activeSuspensionCount(email) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM account_suspensions
    WHERE user_id = (SELECT user_id FROM users WHERE email = ?)
      AND lifted_at IS NULL AND escalated_at IS NULL
  `).bind(email).first();
  return row.count;
}

describe('Strike ladder spares the last operational admin (#3085)', () => {
  it('does not suspend a sole admin who is also the flagged seller, but keeps the strike and logs it', async () => {
    const f = await sellerWithListing('sllad-sole');
    await grantAdminTo(f.seller);

    const resolved = await flagAndApproveSevere('sllad-sole', f.templateId, f.seller.session);
    expect(resolved.response.status).toBe(200);
    expect(resolved.body.suspensionBlockedLastAdmin).toBe(true);

    expect(await activeSuspensionCount(f.seller.email)).toBe(0);
    const strikes = await env.DB.prepare('SELECT strike_count FROM sellers WHERE seller_id = ?')
      .bind(f.seller.sellerId).first();
    expect(strikes.strike_count).toBe(1);
    const logged = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM admin_action_log WHERE action_type = 'strike_ladder_suspension_blocked_last_admin'",
    ).first();
    expect(logged.count).toBe(1);
  });

  it('still suspends a flagged admin-seller when another operational admin exists', async () => {
    // The first test's admin is still operational (never suspended).
    const f = await sellerWithListing('sllad-second');
    await grantAdminTo(f.seller);
    const actingAdmin = await signupBuilder('sllad-acting');
    await grantAdminTo(actingAdmin);

    const resolved = await flagAndApproveSevere('sllad-second', f.templateId, actingAdmin.session);
    expect(resolved.response.status).toBe(200);
    expect(resolved.body.suspensionBlockedLastAdmin).toBeUndefined();
    expect(await activeSuspensionCount(f.seller.email)).toBe(1);
  });
});
