// #4499 (No silent loss): a payout that stops is money waiting, so the person
// is told. Fired when the stored Stripe status moves from `complete` to
// anything else; a repeat of the same event finds the stored status already
// changed and says nothing. Best-effort, like every other notice: it never
// affects the status write that came before it. Plain words, no Stripe
// requirement names (those are on Sell > Payouts).
import { fireNotification } from './notifications.js';

export const PAYOUT_SETUP_NOTICE = 'Stripe needs more information before it can pay you out. Open Payouts to finish.';

// `rows` are the sellers/builders rows (with their table) that held this
// Stripe account, read BEFORE the status write. `previousStatus` is what they
// stored then. One notice per owning builder, even when the same account sits
// on both a seller and a builder row.
export async function notifyPayoutSetupNeedsAttention(db, accountId, owners, newStatus) {
  if (newStatus === 'complete') return;
  const builderIds = new Set();
  try {
    for (const { table, row } of owners) {
      if (row.stripe_onboarding_status !== 'complete') continue;
      if (table === 'builders') {
        builderIds.add(row.builder_id);
      } else {
        const owner = await db.prepare('SELECT builder_id FROM builders WHERE user_id = ?').bind(row.user_id).first();
        if (owner) builderIds.add(owner.builder_id);
      }
    }
    for (const builderId of builderIds) await fireNotification(db, builderId, PAYOUT_SETUP_NOTICE);
  } catch (err) {
    console.error('notifyPayoutSetupNeedsAttention failed', accountId, err);
  }
}
