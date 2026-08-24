# e2e tests

A small, committed Playwright suite that drives the real app (built +
served by `wrangler dev`) through a browser, exercising flows too broad for
`worker/*.test.js`'s unit-level D1 tests — claiming land, uploading a model,
placing it, editing its dimensions, cropping it with Trim, and the identity
picker / modal chrome around all of that.

This exists because every prior round of manual verification lived only in
an ephemeral scratchpad directory outside the repo — real, working
Playwright scripts, proven against the live app, that vanished at the end
of the session they were written in. The next session (or the next feature
touching the same code) had no way to re-run them and had to re-derive test
coverage from scratch. Committing a real suite means that work compounds
instead of evaporating.

## Running it

```
npm run test:e2e                      # every e2e/*.test.mjs file
node e2e/run-all.mjs smoke.test.mjs   # just one file
```

`run-all.mjs` builds the frontend once, then for **each** test file: kills
any stray `wrangler dev`, wipes `.wrangler/state` (local D1 + R2), re-applies
migrations, starts a fresh `wrangler dev --local`, waits for it to answer,
runs the test file as a plain Node script, tears the server down, and moves
to the next file.

**Why a fresh D1 per file, not once for the whole run:** the local D1
instance's landlets get claimed and never released — there's no UI path to
un-claim one, since a real builder giving back land isn't a feature this
prototype needs yet. After a handful of claims in one run, the claim
modal's map has nothing left to offer and `#claim-confirm-btn` stays
permanently disabled for every later test. This isn't a real regression in
the app; it's the shared dev database running out of greenbelt landlets.
Resetting between files sidesteps it entirely. If you see
`#claim-confirm-btn` stuck disabled while debugging a test manually
(outside `run-all.mjs`), that's this — reset `.wrangler/state` and re-apply
migrations rather than debugging the app.

A single test file can also be run directly (`node e2e/smoke.test.mjs`)
against a `wrangler dev` you started yourself — useful while iterating on a
test, since you skip the D1-reset-and-restart cycle between attempts. Just
remember the D1 state carries over between runs when you do this: a test
that expects a *new* builder to appear once in the identity roster (via
`chooseIdentity(..., { isNew: true })`, which clicks `#identity-new-btn` and
types a fixed label) will find several once the same label has been created
a few times in a row — most flows guard against this with `.last()`, but if
you add a new assertion that counts rows or reads roster order, run it
through `run-all.mjs` (or reset `.wrangler/state` yourself) to get a clean
baseline.

## Writing a new test

Import the shared flows from `helpers.mjs` rather than re-deriving them:

- `launchPage({ promptAnswer })` — opens a browser + page against
  `http://localhost:8787`, wires up error collection and
  `window.prompt()` auto-accept (used throughout for naming a new
  builder/seller identity — there's no real text-input modal for it).
- `chooseIdentity(page, { mode, label, isNew })` — drives the identity
  picker for the Build or Sell nav tab. `isNew: true` (the default) clicks
  `#identity-new-btn` first; only call this the *first* time a given
  identity kind is chosen in a session. **Re-entering the same mode later
  in the same session does not reopen the picker at all** — clicking the
  Build nav tab while Build is already `currentMode` is a no-op
  (`#mode-nav`'s own click handler short-circuits on `target === currentMode`),
  and re-clicking Sell when a seller identity is already active skips
  straight past the picker (`ensureSellerIdentity` returns the cached id).
  For those re-entries, just click the nav button and wait for the modal
  you actually want (see `seller-upload-and-resize.test.mjs`'s second Sell
  visit for the pattern) — don't call `chooseIdentity` again.
- `claimLandlet(page)` — drives the claim modal's overhead map to grab
  whatever landlet it offers first, growing the world if needed.
- `clickUntilSelected(page, { x, yStart, yEnd, expectedText })` — scans a
  vertical strip of screen points until `#product-info` shows
  `expectedText`. Needed because a placed item's clickable footprint is
  visibly smaller once it's not wearing the selection gizmo/highlight that
  made a wider area hit it right after placing it — most noticeably right
  after a reload, when nothing starts selected. Retrying one fixed pixel
  can miss forever; scanning a small range doesn't.
- `finish(browser, { pass, label, errors })` — the standard end-of-test
  report + `process.exit(pass ? 0 : 1)`, read by both a direct `node`
  invocation and `run-all.mjs`.

Playwright's `hasText` matcher is a case-insensitive **substring** match
against an element's full `textContent`, descendants included — a locator
like `row.locator('button', { hasText: 'Sell' })` can match both the real
choose button *and* an unrelated element whose id string happens to contain
"Sell" as a substring of, say, "Seller". Disambiguate with `.last()` (the
real button is reliably last in DOM order in every picker this suite
touches) rather than assuming a single match.

If a row can carry two DOM elements with the same generic class doing
similar-looking things (e.g. a save button, a status line), give the new
one its own class rather than reusing the existing one — several tests here
select "the" button/status/row by class and index alone, assuming exactly
one (or exactly three, for per-axis rows) per row. See the Seller modal's
`.seller-size-*` classes for the pattern: same CSS look as
`.seller-axis-row`/`.seller-min-input`/`.seller-save-btn`/
`.seller-row-status`, entirely separate class names.
