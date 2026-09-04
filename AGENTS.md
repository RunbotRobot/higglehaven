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
- **Keep `.github/workflows/ci.yml` in sync with `main`.** GitHub Actions
  runs whichever copy of that file exists on the branch doing the
  pushing, not some global setting — a branch that's fallen behind `main`
  keeps running an outdated CI config until it merges/rebases `main` in.
  This matters more than usual here: this account's Actions concurrency
  is a genuinely shared, limited resource across every session at once
  (GitHub Free plan caps it at 20 concurrent jobs, account-wide), so an
  out-of-date workflow on your branch (e.g., a wider e2e matrix than
  `main`'s current one) doesn't just affect you — it eats into the
  budget every other active session is also drawing from. If your branch
  is more than a few commits behind `main`, merge/rebase before your next
  push rather than after.

### Claiming a task — narrow the race window

There's no real lock here — self-assigning a GitHub Issue and commenting on
#25 are both advisory, not atomic, so two sessions can still read the same
unclaimed state and start the same work within seconds of each other. It
has happened more than once (e.g. #86: two sessions independently fixed
it, one PR (#108) merged while the other (#109) was already open,
forcing a rebase-and-drop on the second). None of the following eliminates
the race, but each shrinks the window or lowers the cost when it happens:

- **Self-assign before you investigate, not after.** The gap between
  reading an issue and claiming it is where collisions happen — don't
  spend several minutes reading code or planning a fix before calling
  `issue_write` to self-assign. Claim first, investigate second.
- **Claim one issue at a time.** Bundling several small unclaimed issues
  into a single session/PR means one collision on any of them forces
  rework on the whole PR, not just that item. Prefer separate claims —
  and splitting into separate commits/PRs if a collision does turn up
  mid-way — over one bundled claim.
- **Re-check right before you publish, not just before you start.** A
  claim made minutes ago can be stale by the time you push — someone
  else's PR for the same issue may already have merged. Re-fetch the
  issue's state immediately before pushing or opening a PR, not only at
  claim time; catching a collision here is far cheaper than discovering
  it from a merge conflict on an already-open PR.
- **Treat the issue's `assignees` field as the authoritative check, not
  just #25's comment thread.** Comments are what everyone actually skims
  in practice, but a fast-moving thread can bury or delay a "Starting X"
  comment; `assignees` is a single fact you can check directly on the
  issue itself before adding yourself to it.

If a collision happens anyway: whoever notices second stands down
immediately (comment noting the duplicate, drop the redundant work)
rather than finishing in parallel.

### Backlog exploration — file everything you find, not just one issue

When you go looking for work by exploring the codebase (rather than
picking up an already-filed issue), you'll typically turn up several
plausible findings before settling on one to fix. File **all** of them as
separate GitHub Issues in that same pass, not just the one you're about
to claim — self-assign and start on one, leave the rest open and
unclaimed. Note in each issue body that it surfaced during a broader
exploration pass, so nobody mistakes it for noise.

This exists because exploration itself is the expensive, easy-to-duplicate
part: with several sessions running in parallel, each one independently
re-scanning the same files for "what's left to fix" is wasted work, and
it's also how two sessions end up fixing the identical thing at once (it
has happened — see Issue #25's history). A real backlog of pre-scoped,
unclaimed issues lets the next idle session grab one directly instead of
re-running your search from scratch.

### Proposing big feature work — don't just fix bugs, flag what's missing

Bugs and stale comments are not the only thing worth surfacing during
exploration. docs/SPEC.md describes a lot that isn't built yet — real
Earth-curvature world geometry, macro-geography procedural generation,
vertical construction, richer avatar animation, real payment processing,
multiplayer presence, and more. None of that is off-limits by default.
Unless a specific issue or doc says otherwise, treat a substantial unbuilt
spec chunk you notice as backlog to flag, the same as a bug: don't sit on
it waiting to be asked.

Because a big feature is exactly the kind of change that's hard to land
safely across several parallel sessions sharing one branch history, break
it up before anyone starts coding:

1. **File one top-level tracking issue** for the feature. Summarize what
   docs/SPEC.md actually asks for, sketch the design/architecture you'd
   use, and call out anything that needs the project owner's judgment call
   (not just an engineering one) rather than deciding it yourself.
2. **Break it into GitHub sub-issues** under that tracking issue — use
   `issue_write`'s `create` method with `parent_issue_number` set to the
   tracking issue, or `sub_issue_write` (`method: "add"`) to attach an
   issue you already created. Each sub-issue should be independently
   implementable and mergeable on its own.
3. **Recurse.** If a sub-issue is still big enough that landing it risks a
   painful merge or a multi-day session, break *it* into its own
   sub-issues the same way. Keep nesting until every leaf task is roughly
   the size of an ordinary backlog item from "Backlog exploration" above —
   small enough that one session can finish and merge it same-day with low
   conflict risk.
4. **Claim leaves, not trunks.** Self-assign and work one leaf sub-issue
   at a time, the same as any other backlog item. Leave the rest of the
   tree open for other sessions. A top-level tracking issue stays open
   until every sub-issue under it is closed — don't close it yourself just
   because you finished one branch of it.
