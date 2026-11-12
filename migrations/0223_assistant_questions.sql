-- #3448 (part of #3444): a question left for the assistants. When every
-- assistant is busy or off shift, a shopper can leave a question instead of
-- walking away empty-handed; it stays queued until an assistant answers it or
-- the shopper withdraws it ("No silent loss"), and the answer is kept until the
-- shopper has seen it, because an answer may arrive long after the shopper
-- closed the panel (conversation messages are kept only 30 minutes).
--
-- "Wait in line" and "leave a question" are one thing: the question is the
-- place in line. The panel shows the place while it is open; closing it keeps
-- the place, and the answer arrives as a notification.
--
-- One active question per shopper (the partial unique index), the same one
-- person at a time rule as a live conversation.
CREATE TABLE assistant_questions (
  question_id TEXT PRIMARY KEY,
  shopper_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- Untrusted text, handed only to an assistant's own inbox, as data.
  text TEXT NOT NULL,
  -- waiting: nobody has it. claimed: an assistant's inbox was handed it and has
  -- not answered yet (it goes back to waiting if they do not within a while).
  -- answered: the answer is stored for the shopper. withdrawn: the shopper took
  -- it back. dismissed: the shopper has read the answer and closed it.
  -- expired: nobody answered within the retention window.
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'claimed', 'answered', 'withdrawn', 'dismissed', 'expired')),
  claimed_by_user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  claimed_at TEXT,
  answer_text TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at TEXT
);

CREATE UNIQUE INDEX idx_assistant_questions_one_active_per_shopper
  ON assistant_questions (shopper_user_id) WHERE status IN ('waiting', 'claimed');
CREATE INDEX idx_assistant_questions_queue ON assistant_questions (status, created_at);
CREATE INDEX idx_assistant_questions_shopper ON assistant_questions (shopper_user_id, created_at);
