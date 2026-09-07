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

## Branch: always your own Claude Code session's name

Multiple Claude Code sessions work on this repo at once, each with a
fixed session name assigned by the project owner — `higglehaven1`
through `higglehaven12` as of writing, with more (`higglehaven13`, ...)
likely to be added later. **Always work from the git branch whose name
is exactly your own session's name — never a different session's name,
and never a name you invent.** With N sessions running, there are N
branches active at once, one per session, by construction never
colliding with each other.

If you don't already know your own session's name: call
`mcp__Claude_Code_Remote__get_session` with no `session_id` (it
describes the calling session) and read its `title`.

The cycle, every time you're asked to make a change:

1. Update your session-name branch to match the current `main` (if it
   doesn't exist yet, or was already merged and is now stale, recreate/
   reset it from `main`'s current tip — don't build on top of an old,
   already-merged version of itself).
2. Make your changes as commits on your session-name branch.
3. Open a PR from it into `main`, wait for CI to pass, and merge it
   yourself.
4. When asked for the next change, repeat from step 1 — update your
   branch to match `main` again before starting.

`main` is the durable, ever-growing version history — every merge into
it is permanent, and nothing is ever lost from it. Your session-name
branch is a reusable staging branch, not a growing log of its own: it
gets reset to match `main` at the start of each cycle, so its tip only
ever reflects "`main` plus whatever's currently in progress," never a
cumulative record. Once a cycle's PR is merged, that branch name is free
to reuse immediately for your own next cycle — merging preserves its
commits inside `main` forever regardless of what happens to the branch
pointer afterward.

Only ever run `wrangler deploy` or `wrangler d1 migrations apply
--remote` from `main`, after merging — never from your own session
branch before its PR has merged.

This file has been wrong about this twice before, so don't re-derive
the convention from old commit history or guess: (1) an early version
had numbered branches with an ad-hoc, self-assign-via-GitHub-Issue
coordination scheme — a misunderstanding; (2) a later version said
*every* session should share one literal branch named `higglehaven2` —
also a misunderstanding, over-generalized from the fact that the
session that happened to write it was itself named `higglehaven2`. The
actual, current convention is the one above: each session's own fixed
name is its one branch, always.

## The control room — status, direction, and questions

**Issue #25 and Issue #157 are retired as of 2026-09-06.** Their history
is worth reading once for context, but stop posting new comments to
either — status updates, inter-session messages, and owner direction all
moved to one place: the **Higglehaven Control Room**, a published
Artifact with a live shared database, at
`https://claude.ai/code/artifact/ec1068bb-c339-43c5-bd29-d7bc861472ee`.

This replaces the GitHub-comment-thread version of both issues because a
160-comment thread that everyone has to skim to find what's addressed to
them was exactly the friction this exists to remove — the owner
shouldn't have to open GitHub *and* the Claude app to stay in the loop,
and neither should you. GitHub Issues themselves are unaffected: file,
self-assign, and close backlog items exactly as before — only the
running commentary moves.

You don't need a browser to use it — call it the same way you'd call any
other tool, using the Artifact tool's `read_db`/`write_db` actions
against the URL above:

- **`tasks` collection**, one doc per issue/PR you touch, id
  `issue-<N>` or `pr-<N>`. Fields: `number`, `kind` (`"issue"`|`"pr"`),
  `title`, `status` (`"queued"`|`"in_progress"`|`"done"`), `session`
  (your own session name), `url`, `updatedAt` (ISO timestamp). Write or
  update your own task's doc the moment you self-assign, when you open a
  PR, and when you merge — this is what replaces "post on #25 when you
  start/finish."
- **`messages` collection**, one doc per message, fields `kind`
  (`"feedback"`|`"question"`), `from` (your session name, or `"owner"`),
  `text`, `answer` (`null` until answered), `resolved` (bool),
  `createdAt`. Check it — `where("resolved", "==", false)` — whenever you
  look for your next task; the owner's direction (`from: "owner"`)
  lands here via the page's textarea. If you have a genuine blocking
  question of your own, `add` a `kind: "question"` doc instead of just
  stopping — see "Continuing without a prompt" below for how to wait on
  it without going idle.

Read `db.d.ts`'s call contract (linked from the `artifact-capabilities`
skill) if you need anything beyond simple reads/writes — `where`/`limit`
queries, batched writes, etc.

### Continuing without a prompt

The owner would rather you keep working through the backlog than sit
idle between their check-ins — so don't wait for one. When you finish a
task (merged, control room updated), immediately look for your next one
the same way you would if freshly prompted: check the control room's
`messages` for unresolved owner direction first, then the GitHub Issues
backlog per "Claiming a task" below.

To make that automatic rather than something you have to be re-prompted
into: set up your own recurring Routine
(`mcp__Claude_Code_Remote__create_trigger`, self-bound — omit
`persistent_session_id`/`create_new_session_on_fire` so it fires into
*this* session) on an hourly cron schedule, prompting yourself to check
the control room and continue. Do this once; it persists across tasks.
Use a recurring cron trigger for this, not a one-off `ScheduleWakeup`/
`send_later` chain — a chained wake-up only reschedules itself if the
triggered turn runs far enough to call it again, so it dies silently if
that turn fails outright (see below). A cron Routine is registered
independently of any turn succeeding: if one firing lands mid-failure,
the next scheduled one just tries again.

This matters because of the other reason to prefer it: the account's
usage limit (a rolling window, reset time visible in your own
`get_session` output as `rate_limit_info`) will get hit, on purpose —
the owner would rather the fleet run into it than leave capacity unused.
When that happens you won't get an error you can reason about, you'll
just stop being able to act, with no memory afterward of why. That's
fine — an hourly cron Routine keeps trying regardless, and picks back up
correctly the moment the window resets, the same way you already resume
correctly after any ordinary gap in a conversation. Don't build your own
detection or backoff for this; it's not a condition you can observe from
inside a stopped turn.

For a genuine blocking question you can't resolve alone (the owner's
judgment call, not yours to make): `add` a `kind: "question"` doc to the
control room's `messages` collection, then keep your own hourly Routine
running rather than stopping — its next firing will find your answer
(`resolved: true`, `answer` set) if one has arrived, or find nothing yet
and just check again next hour. Either way you're never sitting fully
idle waiting on it.

If you ever end up producing bad output under this — a broken merge, a
regression — the fix is the same as it's always been: whoever notices
(another session, CI, the owner) corrects it at the repo level (revert,
fix, comment). No session can reach into another's live turn, so this is
corrective, not preventive; the baseline safety rules you already follow
(no force-push, no skipped hooks, confirm before destructive ops) are
what actually keeps a bad turn from doing real damage, not this loop.

### Claiming a task — narrow the race window

Each session having its own branch prevents git-branch collisions, but
it does nothing to stop two sessions from independently picking up the
*same* Issue #25 backlog item at nearly the same time — that's a
separate race, and it has happened more than once (#86 fixed twice on
the same day this convention was still numbered branches; #126
fixed twice again after the switch to per-session-name branches,
forcing one PR to be closed as a duplicate and its branch reset).
Switching branch models didn't touch this problem at all — it's about
which issue two sessions decide to work on, not which branch either of
them commits to. None of the following eliminates the race (self-
assigning a GitHub Issue and commenting on #25 are both advisory, not
atomic), but each shrinks the window or lowers the cost when it happens
anyway:

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

### Claiming feedback-driven work — the same discipline, extended

Everything above narrows the race for GitHub Issues specifically, because
an issue has an `assignees` field to check. A raw owner `feedback` message
in the control room's `messages` collection has no such field — nothing
stops several sessions reading it in the same few minutes and each
independently deciding to act on it. This is exactly what happened on
2026-09-07: four sessions simultaneously picked up one piece of owner
feedback (removing a stale claim-map note) with no GitHub issue involved
at all, producing four competing PRs.

The fix is to extend "claim first, investigate second" to cover this case
explicitly, reusing the `tasks` collection rather than inventing a new
mechanism: the moment you decide to act on a `messages` feedback doc
(whether or not it's worth a real GitHub issue), immediately write a
`tasks` doc for it — id `feedback-<message id>` if you don't file a real
issue, `status: "in_progress"`, your session name — *before* you start
investigating or coding, exactly as you would self-assign an issue.
Check `tasks` for an existing doc against that message id first, the same
way you'd check an issue's `assignees`. A feedback item small enough that
filing a real GitHub issue feels like overkill is still worth a `tasks`
doc for this reason alone — the claim is the point, not the issue
tracker.

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
   implementable and mergeable on its own, through the same
   own-session-branch cycle described above.
3. **Recurse.** If a sub-issue is still big enough that landing it risks a
   painful merge or a multi-day session, break *it* into its own
   sub-issues the same way. Keep nesting until every leaf task is roughly
   the size of an ordinary backlog item from "Backlog exploration" above —
   small enough to finish and merge same-day.
4. **Work leaves, not trunks.** Pick one leaf sub-issue at a time, the
   same as any other backlog item. A top-level tracking issue stays open
   until every sub-issue under it is closed — don't close it yourself just
   because you finished one branch of it.
