-- #2817 (sub-issue of #2780, itself sub-issue of #2777, proximity voice
-- chat): point-to-point WebRTC signaling relay (SDP offer/answer, ICE
-- candidates) between two nearby avatars. Unlike nearby_chat_messages
-- (migrations/0155)'s landlet-wide broadcast, each row here is addressed
-- to one specific recipient (`to_builder_id`) -- the GET poll in
-- worker/lib/social.js's handleVoiceSignal only ever returns rows where
-- the caller is the recipient, never the whole landlet's traffic.
--
-- Same ephemeral-by-design, cron-pruned shape as nearby_chat_messages --
-- see pruneStaleVoiceSignalingMessages in worker/index.js -- a signaling
-- message is only useful for the few seconds a connection is being
-- negotiated, so nothing here is meant to survive long.
--
-- Both builder_id columns cascade on delete -- a deleted builder's
-- in-flight signaling has no reason to survive them, same reasoning
-- avatar_presence/nearby_chat_messages's own builder_id columns use.
CREATE TABLE voice_signaling_messages (
  message_id TEXT PRIMARY KEY,
  from_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  to_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  landlet_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The GET poll scopes by (to_builder_id, landlet_id) and polls forward
-- from a cursor on (created_at, message_id) -- same leading-index shape
-- idx_nearby_chat_messages_landlet (migrations/0155) and
-- idx_direct_messages_sender/recipient (migrations/0120) already use for
-- their own cursor-paginated queries.
CREATE INDEX idx_voice_signaling_messages_recipient ON voice_signaling_messages(to_builder_id, landlet_id, created_at, message_id);
