-- #4498: a notice can open the thing it is about. `kind` names where a tap on the notice goes
-- ('friends', 'messages', 'assistant', ...); null for older rows and for notices with nothing to open
-- (moderation, admin), which stay plain. No id is stored: each kind opens a whole leaf, not one record.
ALTER TABLE notifications ADD COLUMN kind TEXT;
