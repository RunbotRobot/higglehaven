// #2528: in-app notification helpers (notificationStatement: 1 direct
// caller plus every fireNotification[s] call across the file --
// fireNotifications alone has 7 call sites spanning auctions, disputes,
// and admin actions). Extracted verbatim, zero behavior change.
import { errorMessages } from './validation.js';

export function notificationStatement(db, builderId, message, templateId = null) {
  return db.prepare(
    'INSERT INTO notifications (notification_id, builder_id, message, template_id) VALUES (?, ?, ?, ?)',
  ).bind(`notification-${crypto.randomUUID()}`, builderId, message, templateId);
}

// #1122: notifications.builder_id is NOT NULL REFERENCES builders ON DELETE
// CASCADE, so a target builder who self-deletes in the narrow window
// between a call site reading its id and this INSERT actually running turns
// an explicitly best-effort notification into a real, hard FK failure —
// either surfacing a misleading error for a mutation that already committed
// (when run standalone), or rolling back an otherwise-valid batch entirely,
// including the mutation it was only meant to report on (when previously
// batched atomically alongside it). Every call site now fires its
// notification(s) through fireNotification/fireNotifications below, outside
// of any batch shared with a real mutation, so this specific, expected race
// can never affect anything but the notification itself.
function isForeignKeyConstraintError(err) {
  // errorMessages (above) walks the error's own .cause chain — same
  // unwrapping worker/lib/validation.js's own databaseHttpError already
  // relies on to recognize a D1 constraint failure, since the raw message
  // isn't always on the outermost error object.
  return errorMessages(err).includes('FOREIGN KEY constraint failed');
}

// Exported so #1122's own regression test (worker/notification-fk-race.test.js)
// can exercise the swallow-vs-rethrow decision directly, the same way
// refundIdempotencyKey and auctionSettlementEventId are exported for their
// own tests in worker/index.js.
export async function fireNotification(db, builderId, message, templateId = null) {
  try {
    await notificationStatement(db, builderId, message, templateId).run();
  } catch (err) {
    if (!isForeignKeyConstraintError(err)) throw err;
  }
}

// Same as fireNotification, for more than one recipient at once — each
// still run and caught independently, so one recipient's self-delete race
// never affects another's notification.
export async function fireNotifications(db, notifications) {
  for (const { builderId, message, templateId } of notifications) {
    await fireNotification(db, builderId, message, templateId);
  }
}
