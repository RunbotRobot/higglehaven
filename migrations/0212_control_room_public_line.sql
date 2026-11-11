-- #3446 (part of #3444): the one sentence a shopper may be told about what an
-- assistant (a fleet session) is working on. A card's title and note are never
-- public: they hold internals, issue numbers and sometimes security detail. A
-- session sets this alongside status 'in_progress', written in a shopper's
-- terms; the API validates its shape (one short sentence, no issue numbers,
-- paths, URLs or routes) and clears it when the card is done or the session
-- stands down.
ALTER TABLE control_room_tasks ADD COLUMN public_line TEXT;
