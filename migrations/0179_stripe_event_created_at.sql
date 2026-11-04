-- #3071: the account.updated webhook (worker/lib/stripe.js's
-- handleStripeWebhook) wrote whatever status each event carried, in arrival
-- order. Stripe does not guarantee delivery order and retries failures for
-- days, so a stale account.updated ("complete") could land AFTER a newer one
-- ("restricted") and silently re-enable checkout/payouts for a disabled
-- account. Same shape as #3060 (migration 0178).
--
-- stripe_event_created_at is the Stripe `created` time (unix seconds) of the
-- newest account.updated event applied for this row; an older event arriving
-- later is ignored. NULL until the first such event, which is also how an
-- event with no `created` field leaves it (those keep the old behaviour).
-- In-app writers of the status columns don't touch it.
ALTER TABLE sellers ADD COLUMN stripe_event_created_at INTEGER;
ALTER TABLE builders ADD COLUMN stripe_event_created_at INTEGER;
