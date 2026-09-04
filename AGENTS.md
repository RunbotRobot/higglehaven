# higglehaven agent instructions

- Read `docs/SPEC.md` before making product-level decisions.
- Read `docs/API.md` before changing backend API behavior.
- Real account auth (signup/login) is built and live — see docs/API.md's
  "Authentication". Real payments and multiplayer are still not built —
  that's a real gap against docs/SPEC.md, not a standing instruction to
  leave it alone. See "Proposing big feature work" below: build toward it
  the same way you'd pick up any other backlog item, broken into small
  pieces.
- Use plain `a` in internal code, database, file, and API names. Use accented
  spellings only in customer-facing display strings.
- Use Cloudflare free-tier-compatible designs.
- Run `npm test`, `npm run build`, and `git diff --check`.
- Commit each completed change.

## Branch: always `higglehaven2`

All work happens on one single branch, always named exactly
`higglehaven2` — never a different or numbered name
(`higglehaven1`, `higglehaven3`, `session-2`, etc.). Those other names
are not reserved for anything in particular; `higglehaven2` is simply
the one name to use, every time, regardless of what the work is.

The cycle, every time you're asked to make a change:

1. Update `higglehaven2` to match the current `main` (if `higglehaven2`
   doesn't exist yet, or was already merged and is now stale, recreate/
   reset it from `main`'s current tip — don't build on top of an old,
   already-merged version of itself).
2. Make your changes as commits on `higglehaven2`.
3. Open a PR from `higglehaven2` into `main`, wait for CI to pass, and
   merge it yourself.
4. When asked for the next change, repeat from step 1 — update
   `higglehaven2` to match `main` again before starting.

`main` is the durable, ever-growing version history — every merge into
it is permanent, and nothing is ever lost from it. `higglehaven2` is a
reusable staging branch, not a growing log of its own: it gets reset to
match `main` at the start of each cycle, so its tip only ever reflects
"`main` plus whatever's currently in progress," never a cumulative
record. Once a `higglehaven2` cycle's PR is merged, that branch name is
free to reuse immediately for the next cycle — merging preserves its
commits inside `main` forever regardless of what happens to the branch
pointer afterward.

Only ever run `wrangler deploy` or `wrangler d1 migrations apply
--remote` from `main`, after merging — never from `higglehaven2` before
its PR has merged.

A previous version of this file documented a different scheme —
numbered branches (`higglehaven1`, `higglehaven2`, ...) for running many
sessions in parallel, coordinated via a GitHub Issue. That was a
misunderstanding of the intended convention, not something to revive:
don't create numbered branches, and don't invent a parallel-session
coordination scheme.

### Backlog exploration — file everything you find, not just one issue

When you go looking for work by exploring the codebase (rather than
picking up an already-filed issue), you'll typically turn up several
plausible findings before settling on one to fix. File **all** of them
as separate GitHub Issues in that same pass, not just the one you're
about to work on — self-assign and start on one, leave the rest open
and unclaimed for later. Note in each issue body that it surfaced
during a broader exploration pass, so it's clear where it came from.
This keeps a real backlog of pre-scoped issues around instead of
re-running the same search from scratch next time.

### Proposing big feature work — don't just fix bugs, flag what's missing

Bugs and stale comments are not the only thing worth surfacing during
exploration. docs/SPEC.md describes a lot that isn't built yet — real
Earth-curvature world geometry, macro-geography procedural generation,
vertical construction, richer avatar animation, real payment processing,
multiplayer presence, and more. None of that is off-limits by default.
Unless a specific issue or doc says otherwise, treat a substantial unbuilt
spec chunk you notice as backlog to flag, the same as a bug: don't sit on
it waiting to be asked.

Because a big feature is hard to land safely as one giant PR, break it up
before starting to code:

1. **File one top-level tracking issue** for the feature. Summarize what
   docs/SPEC.md actually asks for, sketch the design/architecture you'd
   use, and call out anything that needs the project owner's judgment call
   (not just an engineering one) rather than deciding it yourself.
2. **Break it into GitHub sub-issues** under that tracking issue — use
   `issue_write`'s `create` method with `parent_issue_number` set to the
   tracking issue, or `sub_issue_write` (`method: "add"`) to attach an
   issue you already created. Each sub-issue should be independently
   implementable and mergeable on its own, through the same `higglehaven2`
   cycle described above.
3. **Recurse.** If a sub-issue is still big enough that landing it risks a
   painful merge or a multi-day session, break *it* into its own
   sub-issues the same way. Keep nesting until every leaf task is roughly
   the size of an ordinary backlog item from "Backlog exploration" above —
   small enough to finish and merge same-day.
4. **Work leaves, not trunks.** Pick one leaf sub-issue at a time, the
   same as any other backlog item. A top-level tracking issue stays open
   until every sub-issue under it is closed — don't close it yourself just
   because you finished one branch of it.
