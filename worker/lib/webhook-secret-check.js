// #1793: a provider's webhook secret left unset (or cleared without a
// redeploy) makes every delivery return 503, which the sender retries and
// eventually drops -- a chargeback, an ID-verification decision or a finished
// video-to-3D job lost with nothing pointing at the cause (No silent loss).
// Accepting unsigned webhooks would be wrong, so the handlers keep their 503;
// this scheduled check is the alerting sibling to checkMigrationDrift
// (migrations/0115), except it raises one Control Room card (no email: the
// owner's standing decision is that proactive email is for genuine
// emergencies only) and logs on every tick.
//
// "In use" = the provider's own API credentials are configured, mirroring the
// stripeConfigured/diditConfigured/tripoConfigured gates: a dev/test
// environment with no provider keys is an intentional unconfigured state and
// raises nothing.
export const WEBHOOK_SECRET_PROVIDERS = [
  { id: 'stripe', label: 'Stripe', secret: 'STRIPE_WEBHOOK_SECRET', inUse: (env) => !!env.STRIPE_SECRET_KEY },
  { id: 'didit', label: 'Didit', secret: 'DIDIT_WEBHOOK_SECRET', inUse: (env) => !!env.DIDIT_API_KEY && !!env.DIDIT_WORKFLOW_ID },
  { id: 'tripo', label: 'Tripo (video-to-3D)', secret: 'TRIPO_WEBHOOK_SECRET', inUse: (env) => !!env.TRIPO_API_KEY },
];

export function webhookSecretCardId(providerId) {
  return `ops-webhook-secret-${providerId}`;
}

export async function checkWebhookSecrets(env) {
  if (!env.DB) return;
  const now = new Date().toISOString();
  for (const provider of WEBHOOK_SECRET_PROVIDERS) {
    const cardId = webhookSecretCardId(provider.id);
    try {
      if (!provider.inUse(env)) continue;
      if (env[provider.secret]) {
        // Self-clearing, like checkMigrationDrift: once the secret is set the
        // card resolves itself instead of waiting for someone to notice.
        await env.DB.prepare(
          `UPDATE control_room_tasks SET status = 'done', waiting_on = NULL, note = ?, note_updated_at = ?, note_author = 'system', updated_at = ?
           WHERE task_id = ? AND status != 'done'`,
        ).bind(`${provider.secret} is set again; ${provider.label} webhooks are being accepted.`, now, now, cardId).run();
        continue;
      }
      console.error(`WEBHOOK SECRET MISSING: ${provider.secret} is unset while ${provider.label} is configured, so every ${provider.label} webhook delivery is being rejected with 503.`);
      const title = `[owner action needed] ${provider.secret} is not set in production, so ${provider.label} webhook events are being dropped`;
      const note = `${provider.label} is configured here but ${provider.secret} is not, so the webhook endpoint answers 503 to every delivery and the sender will eventually give up retrying. Set the secret (wrangler secret put ${provider.secret}) to the signing secret from the ${provider.label} dashboard and redeploy. This card resolves itself once the secret is set.`;
      // INSERT OR IGNORE: one card per provider, raised once. An owner who
      // marks it done keeps it done until it is raised again by a new row id.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO control_room_tasks
           (task_id, kind, note_number, title, status, session, posted_by, waiting_on, note, note_updated_at, note_author, created_at, updated_at)
         VALUES (?, 'feedback', (SELECT COALESCE(MAX(note_number), 0) + 1 FROM control_room_tasks), ?, 'queued', '', 'system', 'owner', ?, ?, 'system', ?, ?)`,
      ).bind(cardId, title, note, now, now, now).run();
    } catch (error) {
      console.error('checkWebhookSecrets failed for', provider.id, error);
    }
  }
}
