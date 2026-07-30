# higglehaven agent instructions

- Read `docs/SPEC.md` before making product-level decisions.
- Read `docs/API.md` before changing backend API behavior.
- Codex owns backend work: `worker/`, `migrations/`, backend tests, Wrangler
  configuration, and backend documentation.
- Claude owns frontend work.
- Do not modify `src/main.js`, `src/catalog.js`, `src/layoutStorage.js`, or
  `index.html` unless the user explicitly assigns frontend work.
- Keep the project dev-only: no auth, payments, or multiplayer unless explicitly
  requested.
- Use plain `a` in internal code, database, file, and API names. Use accented
  spellings only in customer-facing display strings.
- Use Cloudflare free-tier-compatible designs.
- Run `npm test`, `npm run build`, and `git diff --check`.
- Commit each completed change.
