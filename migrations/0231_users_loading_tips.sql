-- #3763 (part of #3759): the "Show tips while the app opens" switch follows the
-- account instead of staying on one device. NULL means the person never chose
-- (each device keeps what it has and tips stay on by default); 0 or 1 is their
-- choice, and 1 means tips are off. Nothing sensitive: one preference bit.
ALTER TABLE users ADD COLUMN loading_tips_off INTEGER;
