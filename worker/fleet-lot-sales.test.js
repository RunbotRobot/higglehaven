// #3597 piece 2 (owner, 2026-11-16, AGENTS.md "The fleet has a lándlet of its
// own in the live world"): a product placed on a lándlet whose builder is a
// fleet account is bought through the ordinary path and the builder's share is
// credited like any builder's (it is simply never spent: see
// fleet-access.test.js). Nothing on the selling side may refuse or miscount
// because the builder is a fleet account.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('fleet-lot-sales-admin')).session;
});

async function builderRow(builderId) {
  return env.DB.prepare('SELECT * FROM builders WHERE builder_id = ?').bind(builderId).first();
}

describe('A sale on a fleet-owned lándlet (#3597)', () => {
  it('credits the fleet builder exactly as it would any builder, with an earnings event', async () => {
    const fleet = await signupBuilder('fleet-lot-builder');
    await env.DB.prepare(
      'UPDATE users SET is_fleet = 1 WHERE user_id = (SELECT user_id FROM builders WHERE builder_id = ?)',
    ).bind(fleet.builderId).run();

    const created = await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId: 'fleet-lot', name: 'Fleet lot', areaM2: 1000, status: 'greenbelt' }),
    }));
    expect(created.response.status).toBe(201);
    expect((await api('/landlets/fleet-lot/claim', fleet.session({ method: 'POST' }))).response.status).toBe(200);
    const template = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'fleet-lot-template',
        name: 'Product on the fleet lot',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 1000,
      }),
    });
    expect(template.response.status).toBe(201);
    const placed = await api('/instances', fleet.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'fleet-lot-instance', landletId: 'fleet-lot', templateId: 'fleet-lot-template', x: 0, y: 0 }),
    }));
    expect(placed.response.status).toBe(201);

    const before = (await builderRow(fleet.builderId)).higgles_balance_cents;
    const buyer = await signupAdmin('fleet-lot-buyer');
    const bought = await api('/instances/fleet-lot-instance/purchase', buyer.session({ method: 'POST' }));
    expect(bought.response.status).toBe(201);
    const { builderShareCents, purchaseId } = bought.body.purchase;
    expect(builderShareCents).toBeGreaterThan(0);

    expect((await builderRow(fleet.builderId)).higgles_balance_cents - before).toBe(builderShareCents);
    const event = await env.DB.prepare(
      'SELECT amount_cents FROM higgles_earnings_events WHERE builder_id = ? AND purchase_id = ?',
    ).bind(fleet.builderId, purchaseId).first();
    expect(event?.amount_cents).toBe(builderShareCents);
  });
});
