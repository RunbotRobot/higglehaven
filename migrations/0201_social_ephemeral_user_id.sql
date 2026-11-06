-- #3147 (4/6 of #3141): the ephemeral social tables -- avatar_presence,
-- nearby_chat_messages, voice_signaling_messages, friend_voice_channel_members
-- -- key on the account (users.user_id), not the resettable builder profile.
-- Owner decision 2026-11-05 (AGENTS.md): "Anything about a person as a person
-- keys on the account". Follows docs/API.md, "Moving a table from builder ids
-- to user ids" (#3144).
--
-- Why rebuilds: every builder-id column here was REFERENCES builders(builder_id)
-- ON DELETE CASCADE (0100/0155/0157/0159), so resetting a builder profile
-- silently deleted that person's presence, chat, signaling and voice-channel
-- rows. The new tables have no foreign key and no cascade; account deletion
-- removes the rows explicitly (worker/index.js, cascadeDeleteAccount).
--
-- Unlike the persistent tables (friendships, direct messages) these rows live
-- seconds to minutes (the prune crons in worker/index.js scheduled()), and the
-- issue allows dropping the builder-id columns in the same PR when every
-- reader is switched, so the retired columns are NOT carried over: nothing
-- reads them any more and there is no history in them worth keeping.
--
-- Backfill: each row's user id comes from builders.user_id so rows in flight
-- at deploy are not lost. A row whose builder has no account (user_id NULL,
-- migrations/0054) cannot be attributed to anyone and is not carried over;
-- such a builder cannot have written these rows through an authenticated
-- session in the first place, and every row here is pruned within minutes.

-- avatar_presence: one live position per account.
CREATE TABLE avatar_presence_new (
  user_id TEXT PRIMARY KEY,
  landlet_id TEXT,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  heading REAL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  flying INTEGER NOT NULL DEFAULT 0
);

INSERT INTO avatar_presence_new (user_id, landlet_id, x, y, z, heading, updated_at, flying)
SELECT b.user_id, p.landlet_id, p.x, p.y, p.z, p.heading, p.updated_at, p.flying
FROM avatar_presence p
JOIN builders b ON b.builder_id = p.builder_id
WHERE b.user_id IS NOT NULL;

DROP TABLE avatar_presence;
ALTER TABLE avatar_presence_new RENAME TO avatar_presence;
CREATE INDEX idx_avatar_presence_landlet_id ON avatar_presence(landlet_id, updated_at);

-- nearby_chat_messages
CREATE TABLE nearby_chat_messages_new (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  landlet_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO nearby_chat_messages_new (message_id, user_id, landlet_id, text, created_at)
SELECT m.message_id, b.user_id, m.landlet_id, m.text, m.created_at
FROM nearby_chat_messages m
JOIN builders b ON b.builder_id = m.builder_id
WHERE b.user_id IS NOT NULL;

DROP TABLE nearby_chat_messages;
ALTER TABLE nearby_chat_messages_new RENAME TO nearby_chat_messages;
CREATE INDEX idx_nearby_chat_messages_landlet ON nearby_chat_messages(landlet_id, created_at, message_id);

-- voice_signaling_messages: point-to-point WebRTC signals, optionally tagged
-- with the friend voice channel they were relayed under (channel_owner_user_id).
CREATE TABLE voice_signaling_messages_new (
  message_id TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  landlet_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  channel_owner_user_id TEXT
);

INSERT INTO voice_signaling_messages_new (
  message_id, from_user_id, to_user_id, landlet_id, kind, payload, created_at, channel_owner_user_id
)
SELECT
  s.message_id, fb.user_id, tb.user_id, s.landlet_id, s.kind, s.payload, s.created_at,
  (SELECT ob.user_id FROM builders ob WHERE ob.builder_id = s.channel_owner_builder_id)
FROM voice_signaling_messages s
JOIN builders fb ON fb.builder_id = s.from_builder_id
JOIN builders tb ON tb.builder_id = s.to_builder_id
WHERE fb.user_id IS NOT NULL AND tb.user_id IS NOT NULL;

DROP TABLE voice_signaling_messages;
ALTER TABLE voice_signaling_messages_new RENAME TO voice_signaling_messages;
CREATE INDEX idx_voice_signaling_messages_recipient ON voice_signaling_messages(to_user_id, landlet_id, created_at, message_id);

-- friend_voice_channel_members: a channel is keyed by its owner's account; it
-- counts as active once the owner's own row (member = owner) exists.
CREATE TABLE friend_voice_channel_members_new (
  owner_user_id TEXT NOT NULL,
  member_user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT,
  PRIMARY KEY (owner_user_id, member_user_id)
);

INSERT INTO friend_voice_channel_members_new (owner_user_id, member_user_id, joined_at, last_seen_at)
SELECT ob.user_id, mb.user_id, m.joined_at, m.last_seen_at
FROM friend_voice_channel_members m
JOIN builders ob ON ob.builder_id = m.owner_builder_id
JOIN builders mb ON mb.builder_id = m.member_builder_id
WHERE ob.user_id IS NOT NULL AND mb.user_id IS NOT NULL;

DROP TABLE friend_voice_channel_members;
ALTER TABLE friend_voice_channel_members_new RENAME TO friend_voice_channel_members;
CREATE INDEX idx_friend_voice_channel_members_member ON friend_voice_channel_members(member_user_id);
