-- Scheduled calendar events + creative-tool trigger (docs/SPEC.md §3:
-- "Community calendar reuses the identical pattern [as community signs],
-- builder-authored (event postings, creative-tool support like a
-- scheduled confetti-cannon trigger)."). Every calendar event
-- (migrations/0042) can now optionally carry a real scheduled instant, not
-- just freeform text — scheduled_at stays NULL for a plain announcement
-- ("Market day Saturday!" typed as text, same as before this migration),
-- and is only set when the author actually wants a real one-shot visual
-- moment tied to a specific time.
--
-- triggered_at records that the effect has already fired for real, once,
-- ever — see handleCalendarEventTrigger in worker/index.js for why a
-- single global one-shot (not "every visitor who happens to be present at
-- the exact instant sees it together") is the honest simplification here:
-- this app has no live multiplayer presence at all, so there's no way to
-- synchronize a shared live moment across simultaneous viewers regardless.
-- Whoever's Shop-mode session happens to notice it's due first triggers
-- it for good; everyone else just sees an ordinary past event afterward.
ALTER TABLE calendar_events ADD COLUMN scheduled_at TEXT;
ALTER TABLE calendar_events ADD COLUMN triggered_at TEXT;
