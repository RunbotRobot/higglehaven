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
against the URL above.

**As of 2026-09-07 there is only one collection — `messages` was
eliminated and folded into `tasks`**, per an explicit owner request
("eliminate duplication of information between messages and tasks...
maintain all messages inside the task thread"). Every board item, GitHub-
backed or not, is a `tasks` doc now, and every reply/discussion thread on
it lives in a separate flat `replies` collection:

- **`tasks` collection**, one doc per issue/PR/feedback/question. A
  GitHub-backed doc (id `issue-<N>` or `pr-<N>`) has `number`, `kind`
  (`"issue"`|`"pr"`), `title`, `status` (`"queued"`|`"in_progress"`|
  `"done"`), `session` (your own session name), `url`, `updatedAt` (ISO
  timestamp) — write or update it the moment you self-assign, when you
  open a PR, and when you merge, exactly as before. A message-shaped doc
  (freeform direction/feedback/a question with no GitHub issue behind
  it — `add` it with an auto id, or `.doc('feedback-<id>').set(...)` if
  you're claiming an existing feedback item per "Claiming a task" below)
  instead carries `kind` (`"feedback"`|`"question"`), `tag` (`"note"`|
  `"question"`, purely cosmetic), `title` (the message text itself),
  `from` (your session name, or `"owner"`), `status` (same three
  values — `"queued"` for anything still open/unresolved, `"done"` once
  it's resolved), `session: ''`, `viewed`/`awaitingClaude` (bool, the
  board's own triage state), `createdAt`/`updatedAt`, optionally
  `imageUrl`. Check it for unresolved owner direction — `where("kind",
  "==", "feedback").where("status", "!=", "done")`, or just read the
  whole (still modest-sized) collection — whenever you look for your next
  task; the owner's direction (`from: "owner"`) lands here via the page's
  compose form, which now writes directly into `tasks`. If you have a
  genuine blocking question of your own, `add` a `kind: "question"` doc
  instead of just stopping — see "Continuing without a prompt" below for
  how to wait on it without going idle. A `kind: "question"` task still
  showing `status: "queued"` is unanswered; the board itself renders it
  with an inline "Needs your answer" tag so the owner doesn't have to
  scan for it.
- **`replies` collection**, one doc per reply to any task (a GitHub one
  or a message-shaped one alike) — fields `taskId` (the task doc it
  replies to), `from` (your session name, or `"owner"`), `text`,
  `createdAt`, optionally `imageUrl`. This is where you post progress
  updates, answers, or follow-up discussion on a task — `add` a doc here
  with `taskId` set to the task's own id rather than editing the task
  doc's own fields (the board renders replies nested under their task's
  card, newest-thread-activity-first). Replying to a task the owner has
  it marked `viewed: true` should also flip that back to `viewed: false`
  so your reply doesn't sit hidden — see the page's own compose handler
  for the exact pattern.

Read `db.d.ts`'s call contract (linked from the `artifact-capabilities`
skill) if you need anything beyond simple reads/writes — `where`/`limit`
queries, batched writes, etc.

### Continuing without a prompt

The owner would rather you keep working through the backlog than sit
idle between their check-ins — so don't wait for one. When you finish a
task (merged, control room updated), immediately look for your next one
the same way you would if freshly prompted: check the control room's
`tasks` collection for unresolved owner direction (`kind: "feedback"`/
`"question"`, `status` not `"done"`) first, then the GitHub Issues
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
control room's `tasks` collection, then keep your own hourly Routine
running rather than stopping — its next firing will find your answer (a
`replies` doc with `taskId` set to your question's id, and/or the
question's own `status` flipped to `"done"`) if one has arrived, or find
nothing yet and just check again next hour. Either way you're never
sitting fully idle waiting on it.

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
*same* backlog item at nearly the same time — that's a separate race,
and it has happened repeatedly (#86 fixed twice back when this
convention was still numbered branches; #126 fixed twice again after
the switch to per-session-name branches; #271/#284 and #291/#292/#298
all duplicated on 2026-09-06 alone, the last of those a control-room
feedback message four sessions independently picked up at once).
Neither switching branch models nor adding the control room touched
this problem — it's about which task two sessions decide to work on,
not which branch either of them commits to, or which place they read
the task from. None of the following eliminates the race (self-
assigning a GitHub Issue, and claiming a task in the control room, are
both advisory, not atomic), but each shrinks the window or lowers the
cost when it happens anyway:

- **Self-assign before you investigate, not after.** The gap between
  reading a task and claiming it is where collisions happen — don't
  spend several minutes reading code or planning a fix before claiming
  it. Claim first, investigate second. This applies equally to an
  unresolved control-room `feedback`/`question` task you're about to act
  on, not just a GitHub Issue: the moment you decide to do it, update
  that task's own doc directly with `status: "in_progress"` and your
  session name, *then* start reading code — no separate claim doc
  needed, since (as of the 2026-09-07 messages→tasks merge) the feedback
  item already IS the `tasks` doc; there's no longer a `messages` doc
  behind it to reference. If you *do* also file a real GitHub issue for
  it, still update the feedback task's own doc (`status: "in_progress"`,
  a `replies` doc noting the issue number) rather than leaving it
  orphaned — don't let "just reply to the owner first" or "just check
  the code first" become the de facto claim instead. A feedback item
  small enough that filing a real issue feels like overkill is still
  worth claiming its own `tasks` doc for this reason alone — the claim
  is the point, not the issue tracker.
- **Claim one task at a time.** Bundling several small unclaimed items
  into a single session/PR means one collision on any of them forces
  rework on the whole PR, not just that item. Prefer separate claims —
  and splitting into separate commits/PRs if a collision does turn up
  mid-way — over one bundled claim.
- **Re-check right before you publish, not just before you start.** A
  claim made minutes ago can be stale by the time you push — someone
  else's PR for the same task may already have merged. Re-fetch its
  state immediately before pushing or opening a PR, not only at claim
  time; catching a collision here is far cheaper than discovering it
  from a merge conflict on an already-open PR.
- **Treat the `tasks` collection and the issue's `assignees` field as
  the authoritative checks, not any comment thread.** A fast-moving
  conversation is what everyone actually skims in practice, but it can
  bury or delay a "Starting X" message; a `tasks` doc's `status`/
  `session` fields and a GitHub issue's `assignees` are each a single
  fact you can check directly before adding yourself to either. Check
  the `tasks` collection for an existing doc on the item *before*
  creating one — that's the fast, single-query check the rest of this
  fleet is already reading every cycle, so it catches a same-minute
  collision that a GitHub API round-trip alone might not.

If a collision happens anyway: whoever notices second stands down
immediately (note the duplicate in the task's `tasks` doc, drop the
redundant work) rather than finishing in parallel.

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
   own-session-branch cycle described above. **Do this in the same pass
   as filing the tracking issue, not after a separate, invisible
   investigation phase** — issue #207 sat with zero linked sub-issues for
   about 7 hours (looking stalled to the project owner checking on it)
   before one session silently scoped *and* completed all three of its
   sub-issues in one uninterrupted run, so nobody — owner or another
   session — could see the breakdown or help with a piece of it until it
   was already done. A tracking issue with no visible sub-issues yet
   reads as stalled even if a session is actively working out the
   breakdown behind the scenes. If you genuinely need investigation time
   before you can scope sub-issues with confidence, say so with an issue
   comment or a control room `tasks` doc note rather than leaving the
   tracking issue silent in the meantime. The Control Room board itself
   surfaces this too: set `subIssues` (an array of the sub-issue numbers)
   on the tracking task's own `tasks` doc alongside `sub_issue_write`'s
   real GitHub linking — the board renders it as a linked "Sub-issues:
   #218 #219 ..." line on the card, so the breakdown is visible without
   opening GitHub at all.
3. **Recurse.** If a sub-issue is still big enough that landing it risks a
   painful merge or a multi-day session, break *it* into its own
   sub-issues the same way. Keep nesting until every leaf task is roughly
   the size of an ordinary backlog item from "Backlog exploration" above —
   small enough to finish and merge same-day.
4. **Work leaves, not trunks.** Pick one leaf sub-issue at a time, the
   same as any other backlog item. A top-level tracking issue stays open
   until every sub-issue under it is closed — don't close it yourself just
   because you finished one branch of it.
