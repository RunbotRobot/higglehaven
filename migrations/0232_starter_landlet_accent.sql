-- #3770: the seeded lándlet's name is the platform's own text, and a person
-- reads it at the top of the open menu. AGENTS.md ("The word is 'lándlet',
-- always") puts the accent on it. Only the exact seeded name changes; a
-- builder who chose their own name is left alone.
UPDATE landlets SET name = 'Starter lándlet' WHERE name = 'Starter landlet';
