-- #2238: calendar_events.user_id (migrations/0135, the real author FK added
-- for #1975) and sign_posts.user_id (migrations/0125, added for #1830) each
-- had a real `WHERE user_id = ?` query land against them later --
-- removeSuspendedUserPostedContent's admin-suspension content-removal
-- cascade and exportSocialSection's GDPR/CCPA data-export endpoint, both in
-- worker/index.js -- with neither column ever getting an index, so both
-- queries are unindexed full-table scans. Same fix shape as #1434's
-- idx_friendships_requester_created/idx_friendships_recipient_created and
-- #1637's idx_direct_messages_sender/idx_direct_messages_recipient: a real
-- query shape existed before the matching index did.
CREATE INDEX IF NOT EXISTS idx_calendar_events_user_id ON calendar_events(user_id);
CREATE INDEX IF NOT EXISTS idx_sign_posts_user_id ON sign_posts(user_id);
