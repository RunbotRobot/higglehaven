-- #2781 (sub-issue of #2777, part of the proximity voice chat work --
-- #2817/#2818's own signaling relay/WebRTC core): friend group voice
-- channels, membership keyed by accepted friendship (worker/lib/
-- social.js's existing friendships model) instead of #2817's own
-- landlet/distance proximity gate -- docs/SPEC.md §2's "Group voice
-- channels for friends regardless of proximity."
--
-- Simplest model consistent with the existing pairwise friend model: one
-- channel per owner (`owner_builder_id` IS the channel -- no separate
-- channel id, since nothing here supports a builder owning more than one
-- channel at a time), with any number of that owner's accepted friends as
-- members. A member only needs to be an accepted friend of the OWNER
-- (checked at join time, worker/lib/social.js's handleFriendVoiceChannels),
-- not of every other member -- same "anyone the host invited talks to
-- everyone else the host invited" shape an ordinary group call uses, not
-- a stricter "everyone must be mutual friends with everyone" requirement.
--
-- The owner's own row (member_builder_id = owner_builder_id) is what
-- marks a channel "active" -- handleFriendVoiceChannels' join branch
-- always inserts it (even when some OTHER accepted friend is the one
-- joining), so the very first join opens the channel; there's no separate
-- "start" step. The owner leaving deletes every row for their
-- owner_builder_id at once, closing the channel for everyone, mirroring a
-- host hanging up a group call.
--
-- Both builder_id columns cascade on delete, same reasoning
-- voice_signaling_messages' own builder_id columns (migrations/0157) use.
CREATE TABLE friend_voice_channel_members (
  owner_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  member_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner_builder_id, member_builder_id)
);

-- GET /voice/friend-channels (channels the caller is currently a member
-- of, including one they themselves own) scans by member_builder_id --
-- the reverse direction from the primary key's own
-- (owner_builder_id, member_builder_id) leading-column order.
CREATE INDEX idx_friend_voice_channel_members_member ON friend_voice_channel_members(member_builder_id);

-- A signal relayed under a friend channel's membership rather than
-- #2817's own landlet-proximity match (worker/lib/social.js's
-- handleVoiceSignal, POST branch) -- nullable; NULL (the overwhelming
-- majority of rows, every ordinary proximity signal) means "the
-- landlet_id column above is the real authorization, as before." Set,
-- it's purely a client-side signal: src/shop/voiceChat.js uses it to skip
-- the distance-based gain ramp for that connection, per SPEC's "no
-- distance-based volume ramp here (unlike proximity voice)." References
-- builders, same cascade-on-delete reasoning as every other builder_id
-- column on this table.
ALTER TABLE voice_signaling_messages ADD COLUMN channel_owner_builder_id TEXT REFERENCES builders(builder_id) ON DELETE CASCADE;
