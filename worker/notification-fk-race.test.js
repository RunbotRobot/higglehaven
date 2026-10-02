// #1122: every "passive notify the other party" call site in index.js fires
// a best-effort notifications INSERT (notifications.builder_id is NOT NULL
// REFERENCES builders ON DELETE CASCADE) after -- or, at several sites,
// atomically batched alongside -- the real mutation it's reporting on. If
// the target builder self-deletes in the narrow window between a call site
// reading its id and that INSERT actually running, D1 enforces the FK and
// throws -- previously a real, unhandled error, either surfacing a
// misleading failure for a mutation that had already committed (a
// standalone call site), or rolling back the whole atomic batch, the real
// mutation included (a batched call site). fireNotification/fireNotifications
// (index.js) now swallow exactly that one expected race; this file exercises
// both the helper directly and clawBackPurchaseCommission, one of the
// previously-batched call sites, already exported for direct testing (same
// reasoning avatar-ownership.test.js's own #888 tests give for calling
// writePurchaseRow directly rather than via the real Stripe checkout ->
// finalize flow this suite never configures). clawBackPurchaseCommission is
// the cleanest batched site to exercise directly: unlike the purchase-write
// sites, its only other statement (the balance debit) is a plain UPDATE
// keyed on builder_id, which simply matches zero rows for a builder that no
// longer exists rather than failing its own FK the way an INSERT would --
// so it isolates the notification's own FK race instead of conflating it
// with a second, unrelated one.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { clawBackPurchaseCommission, fireNotification } from './index.js';
import { signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('fireNotification swallows only the expected FK race (#1122)', () => {
  it('resolves without throwing when the target builder no longer exists', async () => {
    const builder = await signupBuilder('notification-fk-race-gone');
    await env.DB.prepare('DELETE FROM builders WHERE builder_id = ?').bind(builder.builderId).run();

    await expect(fireNotification(env.DB, builder.builderId, 'should never land')).resolves.toBeUndefined();

    const row = await env.DB.prepare('SELECT 1 FROM notifications WHERE builder_id = ?').bind(builder.builderId).first();
    expect(row).toBeNull();
  });

  it('still writes the notification normally when the target builder exists', async () => {
    const builder = await signupBuilder('notification-fk-race-present');
    await fireNotification(env.DB, builder.builderId, 'a real notification');

    const row = await env.DB.prepare('SELECT * FROM notifications WHERE builder_id = ? AND message = ?')
      .bind(builder.builderId, 'a real notification').first();
    expect(row).toBeTruthy();
  });

  it('does not swallow an unrelated failure', async () => {
    // Not a FOREIGN KEY constraint failure -- db itself is unusable -- so
    // this must still propagate rather than being mistaken for the one
    // specific race fireNotification is meant to absorb.
    await expect(fireNotification(null, 'builder-x', 'message')).rejects.toThrow();
  });
});

describe('A refund clawback still debits the builder even when they self-deleted in the window before the notification fires (#1122)', () => {
  it('clawBackPurchaseCommission still applies the balance debit when purchase.builder_id no longer exists', async () => {
    const prefix = 'notif-fk-race-clawback';
    const seller = await signupBuilder(`${prefix}-seller`);
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 1000 WHERE builder_id = ?').bind(seller.builderId).run();

    // Simulates the #1122 race: clawBackPurchaseCommission's caller already
    // read the purchase row (builder_id still pointing at the seller) before
    // the seller self-deleted. purchases.builder_id is ON DELETE SET NULL
    // (migrations/0051/0062), so a real concurrent self-delete would have
    // retroactively nulled the *live* row -- but this already-read `purchase`
    // object, built by hand the same way avatar-ownership.test.js's own
    // #888 tests build one for writePurchaseRow, still carries the stale id,
    // exactly as a genuinely racing caller's in-memory copy would.
    await env.DB.prepare('DELETE FROM builders WHERE builder_id = ?').bind(seller.builderId).run();

    const purchase = { purchase_id: `${prefix}-purchase`, builder_id: seller.builderId, builder_share_cents: 300 };
    // Before #1122's fix, these two statements were batched atomically —
    // the notification INSERT's own FK failure (the seller no longer
    // exists) threw out of this call and rolled back the balance debit
    // along with it.
    await expect(clawBackPurchaseCommission(env.DB, purchase, 'Some product')).resolves.toBeUndefined();

    // The debit's own UPDATE is keyed on builder_id and simply matches zero
    // rows once the seller is gone — nothing to assert on their balance
    // (the row no longer exists), but the call completing at all, past the
    // notification's FK, is the point.
    const notification = await env.DB.prepare('SELECT 1 FROM notifications WHERE builder_id = ?').bind(seller.builderId).first();
    expect(notification).toBeNull();
  });
});
