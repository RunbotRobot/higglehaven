-- N31 (owner, Control Room, 2026-09-11): "I must insist that we move this
-- page to a proper server-based format. That will enable a structured API
-- that we write which can reject calls that don't meet the required
-- criteria (caller name and message text)." The Control Room has lived as
-- a Claude Artifact using the platform's own `db` capability -- real,
-- persistent, shared storage, but with no server-side validation hook: a
-- session writes straight through db.collection('tasks').doc(id).update(),
-- so nothing has ever been able to stop a bare `waitingOn: 'owner'` write
-- with zero explanation (the #610/#616/#653/#659 pattern the owner has
-- flagged repeatedly). Moving the data here, behind a real Worker API,
-- lets that API itself refuse a write that doesn't carry a caller name and
-- message text -- the actual fix, not another client-side badge.
--
-- Column shape mirrors the Artifact db's own tasks/replies collections as
-- closely as SQL allows, since the frontend rewrite and the one-time data
-- migration both need a faithful mapping, not a redesign -- `kind`/`tag`
-- stay free-text (new values have appeared organically over months of
-- multi-session use; a CHECK constraint would just become a recurring
-- migration tax). `sub_issues`/`sub_issue_summaries` stay JSON-in-TEXT for
-- the same reason `metadata_json` does elsewhere in this file: a tracking
-- card's own breakdown shape isn't queried on, only displayed.
CREATE TABLE control_room_tasks (
  task_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  number INTEGER,
  note_number INTEGER,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
  session TEXT NOT NULL DEFAULT '',
  posted_by TEXT NOT NULL DEFAULT '',
  note TEXT,
  note_updated_at TEXT,
  tag TEXT,
  url TEXT,
  pr_url TEXT,
  waiting_on TEXT,
  viewed INTEGER NOT NULL DEFAULT 0,
  awaiting_claude INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  sub_issues TEXT,
  sub_issue_summaries TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The board's own three-column query (WHERE status = ? ORDER BY updated_at).
CREATE INDEX idx_control_room_tasks_status ON control_room_tasks(status, updated_at DESC);
CREATE INDEX idx_control_room_tasks_number ON control_room_tasks(number);

-- from_caller/text are both NOT NULL with no default -- unlike every other
-- required-but-app-enforced field in this codebase, this is the one place
-- the owner specifically asked the DATABASE layer itself to be the backstop
-- (see the API's own validation in handleControlRoomReplyCreate, which
-- rejects before ever reaching this INSERT) rather than trusting a caller
-- to have supplied them.
CREATE TABLE control_room_replies (
  reply_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES control_room_tasks(task_id) ON DELETE CASCADE,
  from_caller TEXT NOT NULL,
  text TEXT NOT NULL,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_control_room_replies_task ON control_room_replies(task_id, created_at);
