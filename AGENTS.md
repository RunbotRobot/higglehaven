# higglehaven agent instructions

- Read `docs/SPEC.md` before making product-level decisions.
- Read `docs/API.md` before changing backend API behavior.
- Real account auth (signup/login) is built and live — see docs/API.md's
  "Authentication". Real payments and multiplayer are still not built;
  keep those dev-only/simulated unless explicitly requested.
- Use plain `a` in internal code, database, file, and API names. Use accented
  spellings only in customer-facing display strings.
- Use Cloudflare free-tier-compatible designs.
- Run `npm test`, `npm run build`, and `git diff --check`.
- Commit each completed change.

## Running multiple sessions in parallel

Track active parallel sessions and claim work via GitHub Issue #25
("higglehaven: active parallel sessions") — read it in full before
starting. Short version:

- Each session works on its own branch, named `higglehaven1`,
  `higglehaven2`, etc. (no fixed scope per number), forked from the
  current trunk (`main`). Merge back via PR.
- Claim a task by self-assigning its GitHub Issue before starting; file
  one if it doesn't exist yet.
- Comment on Issue #25 with your session name/branch/task whenever you
  start or finish something, so other sessions can pick work that's
  well-separated from what's already in flight.
- Only ever run `wrangler deploy` or `wrangler d1 migrations apply
  --remote` from trunk, after merging — never from an in-progress
  session branch.
