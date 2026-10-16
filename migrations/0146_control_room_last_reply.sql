-- #2254: AGENTS.md's own Control Room section documents two behaviors that
-- turn out to have never been built against this real, N31-era API -- an
-- "unconditional" auto-clear of waitingOn from 'owner' to 'claude' when the
-- owner replies, and a distinct "Waiting on: Owner (unexplained)" badge for
-- a queued card whose owner spoke last with no session reply following.
-- Implementing both needs to know who posted the most recent reply without
-- a second query per task on every board load -- same reasoning as
-- note_author/note_updated_at (#914/#1058's own precedent, migration 0096),
-- just denormalized from control_room_replies instead of the task's own
-- note field.
ALTER TABLE control_room_tasks ADD COLUMN last_reply_from TEXT;
ALTER TABLE control_room_tasks ADD COLUMN last_reply_at TEXT;
