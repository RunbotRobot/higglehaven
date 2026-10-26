-- #2779 (sub-issue of #2777, proximity voice chat + general text chat):
-- docs/SPEC.md §2's "Text chat available as an alternative [to voice]" --
-- an ephemeral, nearby-avatars-only text channel. Scoped by landlet_id the
-- same "derive it from the caller's own last-reported avatar_presence row,
-- never trust a client-supplied value" way GET /api/presence (#2269)
-- already does -- so this is the same lightweight "live state scoped by
-- proximity" shape as avatar_presence (migrations/0100), not a persistent
-- chat log: pruned by a cron job the same way (see
-- pruneStaleNearbyChatMessages in worker/index.js), not kept forever.
--
-- `builder_id` cascades the same way avatar_presence's own does -- a
-- deleted builder's chat history has no reason to survive them, and
-- nothing (unlike direct_messages) needs "stays visible in history after
-- the sender is gone" semantics here, since this is ephemeral by design.
CREATE TABLE nearby_chat_messages (
  message_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  landlet_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The GET endpoint scopes by landlet_id and polls forward from a cursor --
-- same two-column-plus-id leading-index shape idx_direct_messages_sender/
-- recipient (migrations/0120) already use for their own cursor-paginated
-- query.
CREATE INDEX idx_nearby_chat_messages_landlet ON nearby_chat_messages(landlet_id, created_at, message_id);
