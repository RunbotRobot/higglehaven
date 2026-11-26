-- #4477: which terminal status Didit reported ('Declined', 'Abandoned', 'Expired'), so the person who
-- closed the tab is not told they were declined. `status` stays 'declined' for all three; nullable, and
-- null on older rows (read as "not approved", the cautious wording).
ALTER TABLE didit_verification_sessions ADD COLUMN end_reason TEXT;
