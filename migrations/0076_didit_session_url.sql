-- #607: handleDiditVerificationSession never reused an already-pending
-- Didit session, contradicting idx_didit_verification_sessions_user_id's
-- own stated intent ("to reuse/report an already-pending one," migration
-- 0075). Fixing that needs somewhere to keep the session's own hosted
-- url so a reused session can still hand the frontend something to open
-- (Didit's own create-session response is the only place url is ever
-- returned, and this table never stored it).
ALTER TABLE didit_verification_sessions ADD COLUMN url TEXT;
