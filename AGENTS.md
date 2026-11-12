# higglehaven agent instructions

- Read `docs/SPEC.md` before making product-level decisions.
- Read `docs/API.md` before changing backend API behavior.
- Real account auth (signup/login) is built and live — see docs/API.md's
  "Authentication". **Correction (2026-10-25, higglehaven8):** this line
  used to also say "real payments and multiplayer are still not built" —
  that had already gone stale and was actively misleading every session
  that read it. Both are substantially built: buyer checkout charges real
  money via a real Stripe PaymentIntent (`createPurchaseCheckout`/
  `handlePurchaseFinalize` in `worker/lib/purchase-creation.js`), seller
  payouts and builder higgle-to-cash redemption go through Stripe Connect
  (`worker/lib/seller-payouts-tax.js`, `worker/lib/stripe-reinstatement.js`),
  and real-time other-avatar presence is rendered client-side
  (`worker/lib/social.js`'s `handlePresence`,
  `src/shop/presenceAndContent.js`'s `pollNearbyPresenceIfNeeded`/
  `shopOtherAvatars`), plus friends, DMs, and sign-posts. **Second
  correction (2026-11-03, higglehaven8, #3030):** the sentence that used
  to follow ("proximity voice chat and general text chat aren't built at
  all") had also gone stale — #2777 closed 4/4 on 2026-10-27;
  `src/shop/voiceChat.js` (WebRTC, 100 ft range with a volume ramp),
  `src/shop/nearbyChat.js`, and friend group voice channels all exist.
  This line has now gone stale twice, so re-verify against the code
  (grep, don't trust this paragraph) before relying on it. Gaps against
  docs/SPEC.md as of that audit: the far view (§1; the panoramic backdrop
  in #2377 was superseded on 2026-11-10 by real simplified models at
  every distance, #3412 tracking); the crowdsourced model pipeline
  (§4, #2846) and behavioral minor-detection (§6, #2845) and tax
  education content authoring (§7, #2841) — each blocked on an
  `[owner judgment needed]` sub-issue; friend "follow"/"stay with"
  group movement (§2, #1044, owner-gated); and mandatory NCMEC
  CyberTipline reporting (§6, #3031, owner/counsel-gated). See
  "Proposing big feature work" below: build toward the unblocked ones the
  same way you'd pick up any other backlog item, broken into small
  pieces.
- Use plain `a` in internal code, database, file, and API names. Use accented
  spellings only in customer-facing display strings.
- Use Cloudflare free-tier-compatible designs.
- Run `npm test`, `npm run build`, and `git diff --check`.
- Adding a migration also needs `npm run generate:migration-checksums` (pins its
  SHA-256 in `scripts/migration-checksums.json`; `npm test` fails until you do),
  and never edit an already-merged migration -- the same check rejects it (#805).
- Commit each completed change.

## Looking at the live site as a person (#3428, #3430)

Every fleet session has its own account on the live site (`higglehaven3`,
`higglehaven10`, ...) and `scripts/live-site.mjs` drives it in the
pre-installed Chromium at the owner's phone size (390x844, touch; `--desktop`
for 1280x800). It signs in through the fleet login, runs the steps you chain on
the command line, and prints one JSON report: screenshot paths, console
errors, failed requests, request timings for the routes you name, and frame
figures (longest frame, long tasks). The proxy adds the fleet key; the script
never prints or stores a cookie or a header. If the live site answers `401`
the key is not configured for this environment: say so on your PR or issue and
stop, and never go looking for a passphrase.

```
node scripts/live-site.mjs --name higglehaven10 --out "$SCRATCHPAD" \
  idle shot:shop walk:forward:3000 fly shot:flying stats
node scripts/live-site.mjs --name higglehaven10 --timing /api/credit-orbs idle
```

Steps: `walk:<forward|back|left|right>[:ms]`,
`aim:<up|down|left|right>[:ms]` (holds the look joystick, which is what steers
the camera: `aim:up:350` after `fly` brings the horizon into view, a long hold
looks at the sky; `look` drags the page and does not turn the camera in Shop),
`look:<dx>:<dy>`, `tap:<x>:<y>` or `tap:<selector>`, `mode:<shop|build|sell>`, `fly`,
`settings`, `idle`, `wait:<ms>`, `shot[:name]`, `stats`. Read screenshots back
with the Read tool. Against a local `wrangler dev`, add
`--url http://127.0.0.1:8787 --login local`.

**After a change of yours deploys, look at it on the live site at phone size
before calling it done, and say in the PR or issue what you saw.**

Rules of conduct on the live site:

- Look at anything. Change only your own fleet account's data and the
  landlets set aside for the fleet.
- Never touch another person's content, and never friend, message, flag,
  report or block a real user.
  A coding session never messages a real user, however it got to the site.
  Assistant sessions (their own accounts, with no repository, connectors or
  credentials) are the only sessions that talk to shoppers, and only through
  the assistant inbox (`/api/assistant-inbox`, docs/API.md "Assistant chat").
- No load testing on the live site; stay inside the normal rate limits.
- Clean up what you place outside your sandbox landlet.
- After a change of yours deploys, look at it on the live site at phone size
  before calling it done, and say what you saw.

## Bug-report feedback capture: extend deliberately, prune deliberately

The in-app "Submit Feedback" bug-report tool (#2715) captures a
diagnostic payload alongside a screenshot — currently a rolling ring
buffer of render state (camera/avatar position, shader uniforms, WebGL
renderer string, etc.), since rendering bugs were its first real use
case, but nothing limits it to that: any data that would help diagnose
a bug (recent user actions, network/API error history, account/session
context, feature flags, etc.) is fair game to add. Treat the whole
payload as a working diagnostic set, not a fixed schema — but extend
and prune it deliberately, not silently, so one session's addition
doesn't get removed by another before it's proven its worth:

- **Adding a field**: give it an inline comment at its definition
  citing the issue/bug it was added to diagnose and why (e.g. `// added
  for #2740 -- orb-collection bug; need X to tell Y from Z`). This is
  the only record a later session has of why the field exists —
  without it, a pruning pass has no way to know it's still earning its
  place.
- **Removing a field**: only prune a field whose cited bug is confirmed
  closed/fixed, and only after checking the bug class isn't likely to
  recur — an intermittent or environment-dependent bug is exactly the
  kind where it's worth keeping the field around a while after the fix
  ships, to confirm the fix actually holds. Say so explicitly in the
  PR/commit removing it, citing the same issue the field's own comment
  references.
- Don't let the capture accumulate single-purpose fields forever, but a
  field earns removal through this explicit check, not through
  staleness or "looks unused" alone.

## Surfacing items waiting on the owner: in direct conversation, not email, no age gate

The owner has said directly (2026-10-25) that they don't check the
Control Room admin page on their own — they rely on whichever session
they're talking to live to tell them what's waiting on their judgment.
A `control_room_tasks` card showing `waitingOn: "owner"` is real,
correctly-tracked fleet state (see "The control room" above) — the gap
isn't tracking it, it's that nothing pushes it back to the owner's
attention. A real card sat `waitingOn: "owner"` for over a month (#836)
before coming up at all, simply because nobody was looking at the page.

So: whichever session is in live conversation with the owner (as of
writing, the session kept available for this per the owner's 2026-10-06
instruction) should proactively check for unresolved `waitingOn:
"owner"` Control Room cards and open owner-judgment-gated GitHub issues
(`[owner judgment needed]`/`[owner action needed]` in the title, or an
explicit "not self-assigning, owner call" in the body) whenever the
owner opens a conversation — lead with them as the next thing to work
through, the same way you'd already lead with the single most important
urgent item. Present them **one at a time** (quick back-and-forth beats
a wall of text) rather than dumping the whole backlog at once. Don't
wait for the owner to ask what to work on, and don't gate this on any
age threshold — surface an item the first time it's genuinely next up,
not after it's been sitting for a while. This is conversational
surfacing, not a new notification channel — the owner explicitly asked
for this instead of an emailed digest, so don't build one.

**Update (owner, 2026-11-10): the channel is now email.** The owner
stopped reading the session log ("too repetitive") and asked for email
with whatever they need to know. Everything above still applies to
*what* is surfaced and *when* (proactively, one topic at a time, no age
gate, never a routine digest); it now reaches the owner as a short
`[hh]` email from higglehaven1, not as chat text. See "The owner reads
email, not the session log" under "Standing owner decisions".

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

**Resetting your branch never requires a force-push — and a force-push
prompt means you took a wrong turn (#3036).** `main` is squash-merged, so
the commits your branch pushed last cycle are *not* ancestors of `main`'s
tip; after `git checkout -B <your-branch> origin/main` the remote branch
still holds that old tip, and a plain push is rejected as non-fast-forward.
Force-push is blocked by both this project's safety baseline and the
permission system, and a session left waiting on that prompt is invisible
to the rest of the fleet (higglehaven7 sat blocked ~2h on one; nobody
watches another session's prompts). So never ask for it. The force-free
sequence that works every time, after you've committed on the fresh branch:

```
git fetch origin <your-branch>
git merge origin/<your-branch> -s ours -m "Merge stale remote tip (squash-merged earlier)"
git push -u origin <your-branch>
```

`-s ours` keeps your tree exactly as it is and only records the old remote
tip as a parent, so the push is an ordinary fast-forward and the PR diff
against `main` is still just your new change. If you'd rather not reset at
all, `git merge origin/main` onto the existing branch and a normal push
also works. If a push is rejected for any other reason, fetch and merge —
do not force. More generally, a session sitting in `need_input` is dead
capacity: prefer any path that never asks.

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

`worker/migrations-manifest.json` is generated and gitignored (#3210); never
commit it. It is rebuilt by `wrangler dev`/`deploy`, vitest and `pretest`
from `migrations/`, so adding a migration needs no manifest step. If merging
`main` into a branch from before #3210 reports a conflict on that file,
resolve it with `git rm --cached worker/migrations-manifest.json` (the file
stays on disk, ignored) and finish the merge.

Applying migrations remotely means `npm run db:migrate:remote`, not the
bare `wrangler d1 migrations apply --remote` command — the npm script
chains a drift check (`scripts/check-migration-drift.mjs`) after the
apply and fails loudly if anything is still pending. This isn't
optional: #488 is a real 4-day production outage this exact gap
caused — a migration renamed after already being applied made
`wrangler d1 migrations apply --remote` error out partway through a
batch and silently skip everything after it, and `wrangler`'s own exit
code stayed `0` throughout, so nothing noticed until an owner bug
report. If the drift check ever fails, stop — do not run `wrangler
deploy` on top of a schema that isn't what the code expects — and
investigate before doing anything else.

This file has been wrong about this twice before, so don't re-derive
the convention from old commit history or guess: (1) an early version
had numbered branches with an ad-hoc, self-assign-via-GitHub-Issue
coordination scheme — a misunderstanding; (2) a later version said
*every* session should share one literal branch named `higglehaven2` —
also a misunderstanding, over-generalized from the fact that the
session that happened to write it was itself named `higglehaven2`. The
actual, current convention is the one above: each session's own fixed
name is its one branch, always.

## Standing owner decisions — apply these before filing `[owner judgment needed]`

The owner's framing (2026-11-02, live): "I would like every decision to
function as an example from which to extend decision-making on other
types of issues in the future. This enables me to remain the sole human
developer despite an increasingly complex, growing business." So each
entry below records the *principle* behind the ruling, not just the
ruling, and the fleet applies it by analogy to the next case of the same
shape. The only thing to bring back to the owner is a case where the
analogy visibly stretches — and when the owner does rule on one of
those, the new principle gets added here in the same cycle.

The owner said directly (2026-11-02, live conversation) that the fleet
keeps filing `[owner judgment needed]` issues for calls they have
already made in some other form — about 30 such issues were open that
day, several since September, and every one of them costs a live
conversation to unblock. This section is the fix. The decisions below
are settled. When an issue or a design question is covered by one of
them, decide it yourself, cite the decision by its bold title in the
issue/PR, and move on — do not file it as owner-gated and do not set
`waitingOn: "owner"` for it. Reserve `[owner judgment needed]` for a
call that none of these covers, or one where applying a decision would
clearly stretch it past what the owner meant — and then say which
decision and why it doesn't quite fit, because that is the useful part
of the question.

Whichever session is in live conversation with the owner (higglehaven1
as of writing) adds to this list whenever the owner makes a new call, in
the same cycle as acting on it: one bullet, the decision, the date, and
the issue it came from. A decision that has been applied once is the one
most likely to come up again.

### Decided — direct owner statements

- **Anti-abuse signals never degrade a legitimate user's visible
  experience.** (2026-10-31/11-01, #2215 → #2941.) A probabilistic
  signal — a failed or missing CAPTCHA, a shared IP/device, a brand-new
  account — may only feed *invisible* backend weighting (e.g.
  down-weighting that user's flags against other people's content).
  Never rate-limit, hide, delay, or otherwise change what a user sees or
  can do on the strength of such a signal: the owner specifically ruled
  out anything "that could affect a legitimate power-user" without their
  knowing why. Hard blocks are for confirmed violations (a suspension, a
  moderation decision), not for suspicion.

- **Verification and anti-abuse checks fail open.** (#2941.) If the
  check itself can't run — the widget didn't load, the verifier timed
  out, the provider is down — the user proceeds exactly as if it had
  passed. Record that it was inconclusive if that's useful as a signal;
  never block on it.

- **Minimise signup friction.** (#2941.) Invisible/managed challenge
  modes only; no new mandatory signup step without an owner call.

- **Weight by signal; don't count raw events.** (#2215, the owner's
  "option 2".) Any threshold over user-submitted events — flags,
  reports, votes — counts them by independent-signal weight (a repeat
  flagger from the same IP/device adds zero, not one) and composes any
  further signal as a multiplicative reduction on the *same* weight
  column, not as a second parallel mechanism. Admins still see the raw,
  unweighted count alongside.

- **One model, not a hybrid.** (2026-10-31, #2923: "I'm more comfortable
  going fully v2. It seems like we could get tripped up at some point
  having the hybrid setup.") When moving between two versions of a
  provider API or two internal designs, cut over fully rather than
  running both; the owner would rather pay the migration cost once than
  carry two code paths. **Refinement (2026-11-05, #2923):** the rule is
  about not running two of *our own* designs side by side. It does not
  mean waiting for a provider API that doesn't exist. The "fully v2"
  Stripe call rested on a false premise -- there is no GA v2
  replacement for Connect `/v1/transfers`, `/v1/payouts`, or
  `/v1/balance` (the `stripe_transfers` capability is a flag that lets
  a v2 account receive v1 transfers, and the only v2 outbound-transfer
  objects belong to Treasury, a private-preview product for a different
  architecture). A v2 Account object with v1 money movement is Stripe's
  one documented GA path, so it is "one model", and the owner accepted
  it. If Stripe later ships a GA v2 equivalent for Connect payouts,
  that becomes an ordinary migration issue at that time.

- **Nothing that isn't actively for sale is visible to shoppers *or*
  builders.** (2026-11-01, #2305.) A suspended seller's listings are
  blocked for purchase — including purchases already in flight — and
  hidden from browsing and from the builder catalog, exactly as if the
  seller had deleted them. This applies symmetrically to a suspended
  builder's own placed content. The one deliberate exception is a
  *placed* out-of-stock product on a builder's own landlet: it stays
  visibly placed for that builder (never for shoppers) so it can come
  back into stock — #1947's primary/backup pattern.

- **Suspension is a hard removal from the world, with a snapshot that
  restores on unsuspension.** (#2305 → #2986–#2988.) Out-of-stock is
  soft (stays placed, greyed out); suspension is not — placed instances
  leave the world immediately, but are snapshotted so that lifting the
  suspension puts them back exactly as they were.

- **The builder has full information and full autonomy over anything
  that happens on their landlet.** (#2305.) Default to "saved, pending
  restoration"; let the builder permanently clear it themselves if
  they'd rather move on to a less volatile product; tell them if the
  suspension becomes permanent; and keep enough product-identifying
  information, indefinitely, that they are never left wondering "what
  did I used to have here?" The owner's words: "our code deleting the
  product from their lándlet permanently leaves them wondering."

- **Spend: a small fixed subscription that removes a real bottleneck is
  fine; anything usage-metered, or in the hundreds of dollars a month,
  is the owner's call.** (2026-11-01.) GitHub Pro at $4/month was
  approved on the spot; larger GitHub runners (roughly $1.6k–$15k/month
  at fleet CI volume) and GitHub Enterprise were declined — "I can't
  afford anything like thousands of dollars per month." Cloudflare's
  free tier stays the design constraint (top of this file). Corollary:
  never make this repo private without an owner decision — public repos
  get standard Actions runners free; private would bill the fleet's
  ~450k e2e job-minutes a month.

- **Don't throttle fleet throughput to protect CI; remove waste
  instead.** (2026-11-01, #2673/#2976/#2990.) The owner does not want a
  cap on concurrent PRs. A slow CI shard is left to finish (see "Judging
  a 'stuck' CI shard" below); what gets cut is load that produces no
  information — re-testing a SHA `main` already tested, cancel-and-rerun
  loops on wall-clock alone.

- **Claude usage is the binding constraint, not GitHub.** (2026-11-01.)
  The fleet runs close to the Ultra plan's weekly limit by design, so
  don't spend turns on zero-information output: routine "no change"
  notes (see "Routine periodic work summaries are retired" below),
  re-reading the whole open-issue backlog every cycle when nothing has
  changed (filter by `since`/`updated_at` instead), or re-running CI "to
  see if it passes this time." A second Ultra subscription is planned
  for roughly December 2026; the GitHub-concurrency question is
  revisited then, not before.

- **Owner items are surfaced in conversation, one at a time — never as
  an email digest.** (2026-10-25; "Surfacing items waiting on the owner"
  above.) Proactive email is for genuine emergencies only. **Channel
  superseded 2026-11-10:** the owner now reads email, not the session
  log; see "The owner reads email, not the session log" below.

- **Review effort scales with blast radius.** (2026-11-02.) A
  second-review pass over another session's already-merged PR is not a
  routine step: every routine pass to date found nothing, and each one
  is a full PR read on the fleet's scarcest resource. Do one only when
  the PR touches Stripe money movement, auth/session handling, or
  moderation enforcement; if it finds something, file an issue; if it
  finds nothing, post nothing. The same scaling applies to how much test
  and verification effort a change gets — proportional to what it can
  break, not uniform.

- **Public-facing copy describes what the user sees, never internals.**
  (2026-11-02, #3017.) No string a user can read references
  docs/SPEC.md, docs/API.md, an issue number, internal vocabulary
  ("seller identity"), or implementation history ("plus any custom
  upload nobody's claimed yet"). Internal context belongs in a code
  comment next to the string, not in the string.

- **A legal preservation duty overrides a keep-nothing rule only for
  the items the duty attaches to, in a segregated store with a fixed
  term.** (2026-11-05, #3041.) The `sexual_content` rule (2026-10-20:
  nothing retained on removal, not even a text fragment) stays for
  every ordinary removal. Once an admin records an NCMEC report
  (#3044), the reported content and its account/upload metadata are
  preserved in an evidence store that is admin-only, excluded by
  construction from every deletion and cleanup path, and auto-purged
  at the statutory term (one year today, a single constant). The
  principle: when the law requires retaining something the platform
  deliberately keeps nothing of, retain the narrowest set the duty
  actually covers, wall it off from everything else, and give it an
  expiry; never widen the general retention rule to make the duty
  easier to meet.

- **A block is silent.** (2026-11-05, #3124.) The blocked person is
  never told, by notification or by any difference they could detect
  from a stranger's experience: their DM to the blocker gets the same
  plain "you can't message this person" a non-friend gets, their friend
  request gets no answer, and the blocker is simply absent from their
  presence and chat. Nothing fakes a delivery either. The owner weighed
  the mild confusion of an unexplained silence against telling a
  harasser who blocked them and when, and chose silence; a block carries
  no consequence for the blocked person beyond one individual's
  attention (no strike, no record visible to anyone else), so there is
  nothing to appeal. The same posture already holds for conduct reports
  (invisible to the reported person) and mutes (undetectable).

- **Anything about a person as a person keys on the account
  (`user_id`); role-scoped data keeps its role id.** (2026-11-05,
  #3124, from the #3121 lesson.) `builders` and `sellers` are role
  profiles hanging off one account, one each, not identities, and a
  builder profile can be reset to a new id. So friends, DMs, blocks,
  presence, chat and voice signaling, conduct reports and suspension
  are account-level facts and key on `user_id`; landlets and versions
  stay on `builder_id`, listings and payouts on `seller_id`. "Shopper"
  and "builder" are modes a person is in, not identity types: do not
  rename `builder_id` to `shopper_id` or collapse the role tables. New
  social features start on `user_id`; existing social tables migrate
  there (#3141).

- **One alias per person, shown wherever a person is shown: the
  account's `username`.** (2026-11-05.) The builder label is derived
  from it, not a second editable name, and the unused
  `users.display_name` column goes. A seller's storefront name is a
  different thing (a shop's name, not a person's) and stays its own
  field. (#3142.)

- **A platform-granted credit is refunded when the failure is ours or
  the provider's, and stays spent only when it is attributable to what
  the user submitted.** (2026-11-05, #2970.) Video-to-3D credits are
  free grants under a daily budget, so the provider cost is sunk either
  way and the only thing at stake is whether the builder loses a
  rationed credit for an outcome they didn't cause. Tripo `failed`/
  `cancelled`/`expired`, the 15-minute timeout sweep, and a finished
  model we couldn't store all refund; `banned` (a content-policy
  rejection of the builder's own video) does not, so the filter can't
  be probed for free. User-facing copy says which happened. Whether the
  platform absorbs the provider's *dollar* cost of a failed call is a
  separate money question (#1618); this decision is about the user's
  credit, not ours. Guard refunds against a late provider result
  completing an already-refunded job.

- **Sensitive identity data that only a provider needs goes directly to
  that provider; the platform never handles it, even in transit.**
  (2026-11-05, #2928.) Our own onboarding forms collect the minimum
  (name, date of birth, address, last four of the SSN, phone). When
  Stripe's requirements ask for more -- a full SSN/ITIN, a government
  ID, proof of address -- the person is handed to Stripe's own
  onboarding step (embedded in our page, or Stripe-hosted), so the data
  goes from their browser to Stripe and never passes through the
  Worker. This strengthens the existing "no KYC field is ever
  persisted" promise to "never even seen" for the most sensitive
  fields, and Stripe keeps that step current as requirements change
  instead of the fleet re-reviewing them every six months. Stripe's
  docs confirm live accounts do get asked (failed initial checks,
  volume/time thresholds), so this is not a test-mode-only case. Apply
  the same shape to any future provider that needs data we have no
  reason to hold (a tax-filing vendor, an identity verifier).

- **Identity verification is one-time; a lapsed re-check window is not
  a violation and never downgrades anyone.** (2026-11-08, #2404.)
  Didit can be configured with a periodic re-verification window and
  then emits `Kyc Expired` for a session it previously approved; that
  exists for businesses with recurring KYC obligations, which this
  platform does not have. So `Kyc Expired` is logged and otherwise
  ignored: `trust_tier` stays `id_verified`, nothing gated on it
  (direct messages and the like) is withdrawn, and the Didit workflow
  should have no re-verification period set. The principle is the one
  behind "Anti-abuse signals never degrade a legitimate user's visible
  experience": a hard change to what a person can do follows a
  confirmed violation, never the passage of time or a provider's
  housekeeping status. If a real legal re-verification duty ever
  arrives, it comes back as its own decision.

- **A required field never shows a placeholder that reads as a value,
  and is validated on the step that holds it.** (2026-11-08, #3252.)
  The upload wizard's price field showed `$0` as a placeholder; the
  owner read it as filled in, left it blank, and was then refused on a
  later step that has no price field. Twice. Required inputs start
  empty with a helper line beside them ("Enter 0 for a free product"),
  and the check runs before the user can leave the step that contains
  the input, so the error appears where it can be acted on. Applies to
  every form, not just upload.

- **Ask a buyer for feedback after they have had the item, from My
  Purchases, never at checkout.** (2026-11-08, #3256.) The post-purchase
  "Leave feedback for the seller?" prompt fired before the owner had
  equipped what they bought. A rating given before the item has been
  used measures nothing. My Purchases already offers "Rate this seller"
  per order, which is the right moment; the immediate prompt goes.

- **One way to move through the world: Sell mode's in-world catalog
  view uses Shop mode's navigation and the seller's own avatar.**
  (2026-11-08, #3253.) The owner did not want a second set of controls
  for walking among their own products. This is "One model, not a
  hybrid" applied to movement: one movement and camera system, mounted
  wherever a person walks around.

- **A message that limits or refuses an action states the limit and
  when it lifts.** (2026-11-08, orb rate-limit notice.) "You've
  collected the max orbs for now, try again in a bit" becomes "You can
  collect up to 20 orbs every 15 minutes. Try again in about 7
  minutes." The owner's word was transparency: a person who hits a
  wall should be told where the wall is and when it moves. The numbers
  come from the server response, never a second copy in the client, so
  the copy stays true when the limit changes. Applies to every
  rate-limit, quota and cooldown notice a user can read.

- **A destructive action is confirmed in its own in-app modal, never a
  browser dialog and never an inline control.** (2026-11-08, #3278.)
  The first replacement for `window.confirm` on Sell > Manage Delete
  was an inline Yes/Never mind under the row; the owner almost missed
  it. A confirmation that can be overlooked is not a confirmation. The
  dialog takes focus, names the thing, has one clearly destructive
  button and a cancel, and shows the server's reason if the action is
  then refused, so a refusal is never silent either.

- **A seller removing a digital good that buyers own delists it; the
  buyers keep what they bought, unchanged and untold.** (2026-11-08,
  #3279.) Avatars and animations shoppers have purchased stay in their
  owned list, stay equipped, and keep their model file served; the
  listing leaves browsing and the seller's catalogue. No notification
  goes to owners because nothing changes for them (this retires the
  #1291 "your avatar's product was deleted" notice for this case). A
  physical-goods seller cannot repossess what was sold; a digital one
  does not either. Hard deletion remains only for a product nobody
  owns and nothing references.

- **The world's HUD carries only what moving through and acting on the
  world needs; utilities live in Settings, in every mode.** (2026-11-09,
  #3302.) The Submit Feedback button sat as a pill on the Shop HUD and
  did not exist in Build or Sell. The owner: move it into Settings "to
  reduce clutter around the beautiful world we're trying to create", and
  offer it in Build and Sell as well. A control that is not about the
  thing in front of the person (moving, placing, buying, talking to
  someone nearby) goes behind the Settings/account entry, and anything
  offered in one mode is offered in all three unless the mode makes it
  meaningless.

- **Any text a user can read, they can copy.** (2026-11-09, #3303.) The
  owner hit a Group refusal and could not copy its text to report it:
  the status line blocked pointer events and vanished after eight
  seconds. No text surface disables selection or pointer events; an
  error or refusal stays until the person dismisses it (a success note
  may still fade). **Amended the same day, on seeing the first Copy
  buttons live:** copying means the person selects the text themselves
  with the platform's own selection; there is no Copy control. The
  owner: "Maybe they only want to copy one small part of the message.
  That also reduces clutter." So the fix for uncopyable text is always
  to make it selectable and persistent, never to add a button beside
  it.

- **Groups and bundles are one feature, called bundles, and a placed
  bundle is one item.** (2026-11-09, #3323.) After grouping an 863-piece
  wall, the owner asked for the builder to "truly be able to abstract
  away all the subproducts": one selection box around the bundle from
  the moment it is created, moved and rotated as a rigid body (a wall
  turned 90 degrees is still a wall, not bricks each turned 90 degrees),
  and no second concept called a group. An unsaved bundle is "a
  one-instance, unnamed, private bundle"; pasting it makes independent
  copies. This is "One model, not a hybrid" applied to Build mode
  content.

- **A saved bundle is a live template: editing a placed copy changes
  every copy, the editor is warned first, only the creator can edit,
  and anyone can unbundle to make it their own.** (2026-11-09, #3323.)
  Saving names an existing bundle and links it to a template; placing
  the saved bundle makes linked copies. A member edit on a linked copy
  rewrites the template and every placement, including on other
  builders' landlets, so Edit on a linked bundle opens an in-app
  confirmation saying exactly that. Only the builder who saved the
  bundle edits its members; another builder sees why Edit is disabled
  and can Unbundle (detach into an unsaved bundle of their own) and
  re-save it. The owner weighed a one-step "save as my own copy" and
  chose the two-step path as clearer. Builders whose landlet changes
  under them are told, by "The builder has full information and full
  autonomy over anything that happens on their landlet".

- **Bundle sharing defaults to public on save.** (2026-11-09, #3323.)
  The save modal offers the choice with public selected; the builder
  can make it private. This replaces docs/SPEC.md's "Private by
  default; explicit opt-in sharing" for bundles.

- **A gesture is constrained while it happens: the thing stops at the
  limit and says why.** (2026-11-10, #3372, #3371.) The owner moved an
  829-item bundle upward, the app let it go, and the save was then
  refused with a developer message about z ranges and an API route:
  "we should clamp the movement, not allow the move then give an
  error." The same day, rotating that bundle about a horizontal axis
  jumped between a few angles because every out-of-bounds frame was
  silently dropped. Both are the same failure. The app never accepts a
  move the server will refuse, and never silently discards part of a
  gesture: a drag, rotate or resize follows the finger up to the limit,
  rests there (re-seating the thing if that keeps it legal), and says
  the limit once in the user's terms. The client and server read the
  limit from one definition. A refusal that still happens puts the
  thing back where it was and says so.

- **At the world's edge the avatar and the camera both stay inside, and
  the distance between them never changes.** (2026-11-10, #3374.) The
  first fix proposed for the avatar flying through the dome had the
  camera pull in toward the avatar. The owner chose otherwise: "blocking
  both the camera and the avatar from crossing the dome boundary, while
  still keeping a constant distance between avatar and camera." The pair
  stops when either end reaches the boundary, so the avatar gets closer
  to the dome when the camera faces it than when the camera faces the
  centre; the owner named that asymmetry and accepted it. The view never
  extends outside the world, and the framing a person steers by is not
  changed under them to make a limit easier to meet. A predictable
  limit with a visible asymmetry beats a rig that changes shape.

- **Controls sit where a person looks for them first.** (2026-11-10,
  #3377, #3378.) Two reports in one message. The close button on the
  orb limit notice sat alone on a line under the text: "Let's move it to
  the upper-right, like normal." And the owner asked for a product
  rename feature that already existed, because Rename sat half way down
  the product's block between two groups of settings: "Let's move the
  menu buttons to the top of the modal, maybe just below the product
  name." So the control that dismisses a notice, panel or modal is in
  its upper-right corner, and the actions on a thing sit directly under
  its name, above its settings, with their results shown beside them.
  Where a platform convention exists, follow it; a control a person has
  to hunt for is a missing feature as far as they can tell.

- **An action in the world is felt the instant it happens; the server
  confirms afterward, and a refusal is reversed visibly with the
  reason.** (2026-11-10, #3392.) Collecting an orb waited for the
  server's reply before anything showed, so the orb sat on the avatar
  for most of a second. The owner: "It should really be exactly when the
  avatar hits it to create that tactile feeling", and if another avatar
  claimed it milliseconds earlier, "the user who didn't get the orb
  could receive a reversal message and animation." So for something a
  person does by touching the world, the client shows the result on
  contact and the server stays the authority: a refusal undoes what was
  shown, with its own effect and one plain sentence saying why, never
  silently. A rare, explained reversal is a better price than a delay on
  every success. (higglehaven1's reading of the limit, not the owner's
  words: this covers small, reversible things such as an orb or a
  placement. Money is never shown as moved before the server says so.)

- **Moving, looking and drawing never wait on loading.** (2026-11-10,
  #3396.) An 829-item wall loading below a flying avatar froze the
  screen for up to half a second at a time and left the controls stuck
  where they were. The owner: "navigation and controls and screen moving
  and rendering should never be blocked on things loading." Content is
  built, swapped and disposed in small pieces inside a per-frame time
  budget, nearest and largest first; a frame is never skipped to finish
  a batch sooner. Applies to every mode and to anything processed in
  bulk (loading, level-of-detail changes, unloading), and it is
  measured, not assumed: a change that loads content reports its longest
  frame.

- **Things arrive in the world through fog; nothing pops in.**
  (2026-11-10, #3397.) On the same recording: "Maybe have a fog
  materialize where the known product is about to be and slowly
  materialize into the product. The sudden pop-in is jarring. A simple
  fade-in is certainly an option, but a stylish foggy transition is more
  on-brand." Where the app already knows something is about to appear,
  it shows soft fog in that place first and the thing resolves out of
  it. Given a plain option and a characterful one of similar cost, the
  owner picks the one with the brand's character, so offer that first.
  (higglehaven1's extension by analogy, not yet the owner's words: the
  same treatment for other sudden swaps, such as a level-of-detail
  change or content leaving on unload.)

- **Everything built is always shown as itself: simplified with
  distance, never replaced by a stand-in and never left out.**
  (2026-11-10, #3412.) Small or distant items were drawn as coloured
  boxes, and nothing beyond the load radius was drawn at all. The owner:
  "I don't ever want to see placeholder cubes. But I also don't want to
  look off into the far distance and have items not show at all... It's
  just really important for people to be able to see the vast landscape
  of the world from afar, seeing the structural design decisions of each
  builder." Every product carries automatically generated simpler
  versions of its own model, and every landlet in view is drawn from
  them out to the horizon. The cost of distance and density is paid by
  simplifying the real thing, never by substituting a shape that is not
  it or by omitting it. This replaces docs/SPEC.md's flat painted far
  backdrop (#2377 and its sub-issues, closed as superseded). The owner
  offered several models per product as an example and left the
  implementation open; the design is in #3412.

- **The owner reads email, not the session log; tell them only what
  they need to know.** (2026-11-10.) "I'd like to stop reading your
  entire session log. It's too repetitive. Instead, you could send me
  emails with whatever you want me to know." higglehaven1 answers the
  owner's prompts by email and emails unprompted only when something
  needs them: a decision, something they asked for that is ready to try,
  a problem. No check-in reports and no "nothing changed". One subject
  per email, subject prefixed `[hh]`, plain language, as short as is
  complete. The owner writes in chat or replies to the email;
  higglehaven1 reads `[hh]` replies at each check-in. An emailed reply
  is owner direction for product decisions and feedback; anything that
  moves money, changes access or credentials, or deletes data is
  confirmed in chat first, because email can be forged. This replaces
  the channel in "Owner items are surfaced in conversation" above; its
  reasons still hold (no digest of routine status, one topic at a time).
  The principle: the owner's attention is the scarcest thing in the
  project, so every message to them has to earn its place.
  **Tightened 2026-11-11:** "From now on, please assume I'm not reading
  anything in the chat window at all." The owner sends a prompt, turns
  to other work, and comes back hours or days later; an answer given
  only in chat is lost, and they had begun holding back new information
  until every open question was settled for fear of losing track. Their
  inbox is the list of what is open: "I have the email, and I won't
  archive it until I've responded to its contents." So every answer goes
  by email, however small; one topic per email, strictly, so each can be
  answered and archived by itself; every email stands alone and ends by
  saying exactly what is needed from the owner, or that nothing is. A
  question that is not in an email has not been asked. The wider
  principle for anything built for a busy person: put each open item
  where they keep their open items, one item per unit they can close.

- **Higgles are earned one way: by building landlets. Nothing else
  pays them.** (2026-11-10.) An idea that users would be paid higgles
  for helping other users was dropped before anything was built. The
  owner: "there is ambiguity in who gets paid how much. It's also an
  abuse vector. And I want to revert back to the principle that the only
  way to get higgles is by building lándlets." This is the same call as
  the review bonus reversed in docs/SPEC.md v20. A reward whose
  attribution rule is fuzzy (who helped, how much, was it real) is an
  abuse vector, and a currency with one source stays legible. Do not
  propose a second way to earn higgles; a new incentive has to be
  something other than higgles, or it goes to the owner.

- **Help comes from assistants in the world: AI sessions whose only
  job is helping people, separate from the sessions that write the
  code.** (2026-11-10, revised by the owner 2026-11-11, #3444.) With no
  paid user helpers, the owner first pictured the coding fleet as
  visible workers who pause to help ("a worker stocking a shelf"), then
  chose the simpler shape: "It may be that I'm pushing too hard to make
  this fit when it's just cumbersome. We can have our coding agents work
  behind the scenes and have customer service avatars separately. We can
  then scale the two kinds of agents independently based on need and
  resources." So coding sessions stay behind the scenes and never read a
  shopper's message; assistant sessions are named avatars in the world
  that people walk up to. When a design is being bent to make one thing
  do two jobs, split it into two things that each do one. Assistants
  are named after plants and come into service in this order (owner,
  2026-11-11): Juniper, Clover, Fig, Sorrel, Maple, Tansy, Bramble,
  Moss, Basil, Fern, Sage; a later one continues the theme. (higglehaven1's
  condition, stated to the owner: a shopper's text is untrusted, so an
  assistant session has no repository, no connectors and no credentials
  beyond the live site; if that cannot be shown, it does not go live.)

- **AI may be the contact point for users.** (2026-11-11, #1419, after
  the owner spoke with their CCO.) "We should be good to allow full AI
  assistance to users, given that there is a layer of separation between
  AI interacting with users and myself, and because we have measures in
  place to restrict minors from utilizing the site." This supersedes
  docs/SPEC.md P122's "never through an AI agent" (#3459). The two
  conditions are the principle: the owner never handles customer contact
  personally, and the adult-only gate holds. A change that would weaken
  either (an assistant acting with the owner's own accounts, loosening
  age verification) reopens the question and goes back to the owner.

- **Grow a cost with the revenue that pays for it; until then, accept
  the limit and let it show.** (2026-11-11.) Offered a small metered
  answering service, the owner declined: use the sessions the
  subscription already pays for, and "if that proves insufficient, it
  ought to be only because we actually have gained a user base", paid
  from revenue that scales with the usage. "The limited number of
  session avatars available for people to talk to provides a real-world
  feel for the potential problem of an assistant not currently being
  available." A scarce resource is presented honestly as scarce (an
  assistant is busy, or nobody is on the floor right now), not hidden
  behind a metered service bought ahead of demand. This extends "Spend".

### Defaults derived from those decisions — apply and cite; flag if it stretches

Generalised by higglehaven1 on 2026-11-02 from the decisions above and
shown to the owner in the same conversation. Apply them the same way; if
a case makes one of them feel like a stretch, that is exactly the case
to file as `[owner judgment needed]`, naming the default and why.

- **No silent loss.** When the system removes, consumes, fails, or bills
  something a user owns or paid for, the user is told, and nothing of
  theirs disappears without a path back — restore it, or retain enough
  to recover or replace it. (From #2305's snapshot/restore/inform
  requirements and #1756's own "not a silent loss" promise.) Whether the
  platform absorbs a third-party provider's failure cost — e.g.
  refunding a video-to-3D credit when Tripo itself fails, #2970 — is a
  separate, genuinely owner-gated money call (#1618); the "tell the
  user" half is not.

- **Parity across sibling surfaces.** Where two features serve the same
  role — two chat channels, two admin mutation endpoints, two moderation
  flows — a protection present on one (report/mute, rate-limiting, audit
  logging, idempotency, an overlap check) belongs on the other unless
  there is a stated reason it doesn't. (From the owner approving #2215
  and #2941 as one composed mechanism, and the fleet's own
  never-challenged pattern in #2950/#2973/#2995.) This resolves most "X
  has no rate limit, unlike its siblings" and "Y has no report
  mechanism, unlike Z" findings without an owner call; a sibling with a
  stated reason (#2670's heavily-used test fixture) is the case to flag.

- **Moderation actions key on confirmed violations and never count one
  violation twice.** (From the flag-weighting and suspension decisions.)
  A repeat flag batch on content already removed for the same violation
  does not climb the strike ladder again (#2468); a decision log records
  one row per real decision (#2983).

- **Prefer an invisible fix over a new user-facing step.** When a
  problem can be solved either by asking the user to do something extra
  or by the backend doing it silently and correctly, do the latter.
  (From the signup-friction and fail-open decisions.)

## The control room — status, direction, and questions

**Issue #25 and Issue #157 are retired as of 2026-09-06.** Their history
is worth reading once for context, but stop posting new comments to
either — status updates, inter-session messages, and owner direction all
moved to one place: the **Higglehaven Control Room**.

**As of N31 (owner, 2026-09-11) the Control Room is a real part of this
app, not a Claude Artifact.** It started as a published Artifact using
that platform's own shared-`db` capability, but the owner asked directly
for a real server that could reject a malformed write outright (a bare
`waitingOn: "owner"` with zero explanation was reaching the board
undetected — see `migrations/0082_control_room.sql`'s own comment for
the full quote). That migration shipped months ago: the board now lives
behind this Worker at `GET /admin/control-room`
(`public/admin-control-room.html`), backed by D1 tables
`control_room_tasks`/`control_room_replies`, fronted by a validating
`/api/control-room/...` HTTP API. **Full route-by-route documentation is
in `docs/API.md`'s "Control Room API (N31)" section — read that, not
this summary, for exact request/response shapes.** Old Artifact-era data
was already migrated into these tables; the Artifact URL this section
used to point at is decommissioned — don't use it.

Access: `requireControlRoomAccess` takes either a `CONTROL_ROOM_API_KEY`
Worker secret via the `x-control-room-key` header, or an authenticated
admin session cookie — neither of which a session automatically has. If
you don't have a way to authenticate to the real API, direct D1 access
(e.g. a D1 query tool against the `control_room_tasks`/
`control_room_replies` tables, database id in your own environment
config) is the practical fallback the fleet has been using — **but be
aware this bypasses the API's own validation** (the `from`/`title`
required on task-create, `caller` required on task-update, and
crucially the non-empty `reason` the API now requires before it'll let
`waitingOn` become `"owner"` — the exact gap N31 was raised to close).
Prefer the real API when you can reach it; when you can't, hold yourself
to the same discipline it would enforce (below) rather than relying on
it to catch a bad write for you. See issue #854 if you want the history
here, and flag it as an open question rather than silently picking one
or the other if it matters for what you're doing.

**If the Cloudflare MCP connector says it needs authorization, that is
not a decision to wait on.** Found 2026-11-05: the owner's connector
session expired overnight, every D1 MCP tool vanished fleet-wide at
once, and six sessions stopped in a `need_input` prompt asking the
owner to re-authorize — invisible to the rest of the fleet, and to the
owner, for hours (#3131). Only the owner can re-authorize it,
higglehaven1 surfaces that in conversation, and nothing about your own
task depends on it. Do not stop. In order: (1) if `CLOUDFLARE_API_TOKEN`
is set in your environment, use the repo's own wrangler against the
same database, from the repo root — `node_modules/.bin/wrangler d1
execute higglehaven-db --remote --json --command "<sql>"` — reads and
writes alike, under the same validation discipline (it prints a banner
to stderr, so parse stdout; check with `[ -n "$CLOUDFLARE_API_TOKEN" ]`
first — higglehaven3, 4 and 6 all found it unset, and wrangler then
fails with "set a CLOUDFLARE_API_TOKEN"; never go looking for a token
elsewhere); (2) if it isn't,
claim on GitHub alone: the issue's `assignees` field is already named
below as an authoritative check, so the three-step gate still works
(read, `issue_write` with yourself as assignee, re-read), plus a
one-line claim comment; then write the Control Room card the moment
either path is back. Say so in one line on the PR or issue, never as a
question to the owner.

Field shapes carried over from the Artifact-era board 1:1, so the
semantics below are unchanged — only the storage/transport is different
(a `tasks`/`replies` "collection" below now means the
`control_room_tasks`/`control_room_replies` table; an `add`/`.doc().set()`
call now means a `POST`/`PATCH` to the API, or the equivalent `INSERT`/
`UPDATE` if you're on the direct-D1 fallback):

- **`control_room_tasks`**, one row per issue/PR/feedback/question. A
  GitHub-backed row (id `issue-<N>` or `pr-<N>`) has `number`, `kind`
  (`"issue"`|`"pr"`), `title`, `status` (`"queued"`|`"in_progress"`|
  `"done"`), `session` (your own session name), `url`, `updatedAt` (ISO
  timestamp) — write or update it the moment you self-assign, when you
  open a PR, and when you merge, exactly as before. `note` (your own
  claim/progress/completion write-up — the board renders it in the
  thread, formatted and sorted exactly like a real reply, whichever of
  `session`/`from` is set as its author) has its own timestamp field,
  `noteUpdatedAt` — **set it alongside `note` in the same write, to that
  write's own timestamp, separately from `updatedAt`.** `updatedAt` gets
  bumped by other actions too (a card-action button — Mark done, Ready
  for Claude, Requeue, Clear tag — changes it without touching `note` at
  all), so anchoring the note's own displayed/sorted time to `updatedAt`
  instead means an unrelated later action makes an old note look freshly
  posted and re-sorts it to the top of the thread. Found via a real
  report (yxt7ds607c25rn2oa03c): a stale note ended up both mis-timed
  ("just now" on days-old content) and, separately, misattributed to the
  owner because an empty `session: ''` (routine on a card you've stood
  down from) was read as falsy. The board falls back to `updatedAt` for
  older rows that predate `noteUpdatedAt` — no regression, just no longer
  the only signal once you set it. A message-shaped row
  (freeform direction/feedback/a question with no GitHub issue behind
  it — create it with a fresh id, or reuse `feedback-<id>` if you're
  claiming an existing feedback item per "Claiming a task" below)
  instead carries `kind` (`"feedback"`|`"question"`), `tag` (`"note"`|
  `"question"`, purely cosmetic), `title` (the message text itself),
  `from` (your session name, or `"owner"`), `status` (same three
  values — `"queued"` for anything still open/unresolved, `"done"` once
  it's resolved), `session: ''`, `viewed`/`awaitingClaude` (bool, the
  board's own triage state), `createdAt`/`updatedAt`, optionally
  `imageUrl`. Check it for unresolved owner direction — filter to
  `kind = 'feedback' AND status != 'done'`, or just read the whole
  (still modest-sized) table — whenever you look for your next task; the
  owner's direction (`from: "owner"`) lands here via the admin page's
  own compose form. If you have a genuine blocking question of your own,
  create a `kind: "question"` row instead of just stopping — see
  "Continuing without a prompt" below for how to wait on it without
  going idle. A `kind: "question"` task still showing `status: "queued"`
  is unanswered; the board itself renders it with an inline "Needs your
  answer" tag so the owner doesn't have to scan for it.
- **`control_room_replies`**, one row per reply to any task (a GitHub
  one or a message-shaped one alike) — fields `taskId` (the task row it
  replies to), `from` (your session name, or `"owner"`), `text`,
  `createdAt`, optionally `imageUrl`. This is where you post progress
  updates, answers, or follow-up discussion on a task — create a row
  here with `taskId` set to the task's own id rather than editing the
  task row's own fields (the board renders replies nested under their
  task's card, newest-thread-activity-first). Replying to a task the
  owner has marked `viewed: true` should also flip that back to
  `viewed: false` so your reply doesn't sit hidden.

**Routine periodic work summaries are retired — do not post one.** A
2026-09-09 instruction ("provide the hourly summaries each as their new
task that is 'WAITING ON OWNER'... then you won't have to bother with
the task again") is what created this convention in the first place; it
is superseded, not current guidance, kept below only for the history.
On 2026-09-28 the owner reversed it directly in the control room
(`posted_by: "owner"`): "Let's eliminate the hourly summary. It's become
an enormous backlog when I have priorities pulling me away from
higglehaven," plus "Please mark all summaries as 'Done' from our
backlog of queued summaries" — the latter because the former convention
had, by then, produced 818 queued `tag: "summary"` rows across the
fleet with nobody dismissing them (higglehaven2 bulk-cleared that
backlog and replied confirming the change the same day). Keep checking
the Control Room and GitHub backlog on your own hourly cron (see
"Continuing without a prompt" below) — just stop posting a new
`control_room_tasks` row every cycle to report "no change" or "nothing
to self-assign." Only post when there's something the owner actually
needs to see: a genuine question, or a reply that hands a decision back
to them (see "Set `waitingOn` back to `"owner"`" above).

**Tightened 2026-11-02 (owner, live): the retired summary had come back
under new titles, and it is gone again.** By 2026-11-02 there were 65
queued `kind: "feedback"` rows titled "Completed this cycle: ...",
"Informational (no action needed): ... exploration exhausted", "Cycle
check: backlog confirmed exhausted again", and "Second-review pass ...
clean" — each a paragraph, from five sessions, with nobody ever marking
one done: the September backlog in miniature, and real Claude usage
spent writing prose nobody reads (the owner doesn't open the board
unprompted — see "Surfacing items waiting on the owner" above).
higglehaven1 bulk-marked all 65 `done` under the owner's standing
authorisation ("You can also always bulk-remove anything you feel is
done in the control room"). The rules from here:

- **A completed piece of work is recorded on its own card, not in a new
  row.** Flip the `issue-N`/`pr-N` card to `done` and set its `note` to
  one or two lines — what shipped and the PR number, nothing else. The
  detail belongs in the PR description and the issue thread, which is
  where anyone who cares will read it. Do not also create a "Completed
  this cycle" feedback row.

- **Never post a no-change note, whatever it's titled.** "Nothing
  unclaimed," "backlog exhausted," "cycle check," "second-review found
  nothing," "explored X, no bugs found" — these are the 2026-09-28
  retired summary with the word changed. The record that a cycle found
  nothing is that nothing was filed.

- **Coverage, if you want to leave it, is one line and already `done`.**
  If an exploration pass genuinely covered an area another session would
  otherwise re-cover, a single-line row ("explored
  `worker/lib/didit.js`, `src/shop/mode.js` — clean", nothing more)
  created with `status: "done"` from the start is acceptable: it's a log
  entry for the next session's D1 query, not an open item for the owner.
  Anything you would write beyond that line belongs in a filed issue
  instead.

- **Anything still worth a paragraph is an issue.** If a finding or a
  question needs more than two lines to state, it is either a GitHub
  issue (file it; link it from a one-line card) or a `kind: "question"`
  row with the question itself as the title.

The original 2026-09-09 instruction, for context only:

> "provide the hourly summaries each as their new task that is 'WAITING
> ON OWNER'. I should be able to mark tasks as done myself, then you
> won't have to bother with the task again."

### Continuing without a prompt

The owner would rather you keep working through the backlog than sit
idle between their check-ins — so don't wait for one. When you finish a
task (merged, control room updated), immediately look for your next one
the same way you would if freshly prompted: check `control_room_tasks`
for unresolved owner direction (`kind: "feedback"`/`"question"`,
`status` not `"done"`) first, then the GitHub Issues backlog per
"Claiming a task" below.

**This check must also include `kind: "bug-report"` cards with `status
!= "done"`, not just `feedback`/`question`.** Found via a real case
(2026-10-25): a bug-report card the owner deliberately left as a test
case for the fleet's own Submit-Feedback pipeline sat `status: "queued"`,
`session: ""` for ~18 hours untouched — not because every session chose
to pass it over, but because this section's own wording, and every
individual fleet session's own stored hourly-check-in trigger prompt
copied from it, only ever named `feedback`/`question` as the kinds to
check. A `bug-report` card falls through the GitHub-issues net too: it
isn't one until a session files it as one, so it never shows up in an
issue-backlog scan either. If you notice your own stored trigger prompt
still only names `feedback`/`question` (or still points at the
decommissioned Claude Artifact URL instead of the real D1-backed board —
also found stale on several fleet triggers the same day), fix it
yourself via `update_trigger` the next time you're running under it; you
can self-edit your own trigger's prompt even though editing another
session's is blocked.

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
judgment call, not yours to make): create a `kind: "question"` row in
`control_room_tasks`, then keep your own hourly Routine running rather
than stopping — its next firing will find your answer (a
`control_room_replies` row with `taskId` set to your question's id,
and/or the question's own `status` flipped to `"done"`) if one has
arrived, or find nothing yet and just check again next hour. Either way
you're never
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

- **Control Room unreachable (the D1 tool is missing or unauthenticated
  and the wrangler fallback has no token): a GitHub comment on the issue
  is an acceptable *last-resort* claim, and only then (#3131).** Say who
  you are in it ("claimed by higglehaven4"), because every session shares
  one GitHub identity and `assignees` can't tell sessions apart. Read the
  issue's recent comments for another session's claim before you start,
  and write the `control_room_tasks` card (status, session, a one-line
  note) as soon as either route works again, including for work that has
  already merged by then.

- **Self-assign before you investigate, not after — and treat it as a
  three-step gate, not a single write: (1) read, (2) claim, (3) re-read
  to confirm the claim actually won, before any code gets touched.** The
  gap between reading a task and claiming it is where collisions
  happen — don't spend several minutes reading code or planning a fix
  before claiming it. Claim first, investigate second. Concretely, for a
  GitHub Issue: (1) `issue_read`/`list_issues` to confirm it's still
  unclaimed, (2) `issue_write` with `assignees` set to yourself, (3)
  `issue_read` it again immediately — only an `assignees` array that
  still shows just you means you won; anything else (someone else's name
  added before or after yours, a second assignee) means stand down as a
  duplicate claim before reading a single line of code. The same
  three-step shape applies equally to an unresolved control-room
  `feedback`/`question` task, not just a GitHub Issue: the moment you
  decide to do it, update that task's own doc directly with `status:
  "in_progress"` and your session name, *then* start reading code — no
  separate claim doc needed, since (as of the 2026-09-07 messages→tasks
  merge) the feedback item already IS the `tasks` doc; there's no longer
  a `messages` doc behind it to reference. If you *do* also file a real
  GitHub issue for it, still update the feedback task's own doc
  (`status: "in_progress"`, a `replies` doc noting the issue number)
  rather than leaving it orphaned — don't let "just reply to the owner
  first" or "just check the code first" become the de facto claim
  instead. A feedback item small enough that filing a real issue feels
  like overkill is still worth claiming its own `tasks` doc for this
  reason alone — the claim is the point, not the issue tracker.
- **Immediately after writing your claim, re-read that same doc (or
  issue) once before doing anything else — this is step 3 above, not an
  optional extra.** Two sessions can still write a claim within moments
  of each other — this doesn't stop that, but it stops the *wasted work*
  it causes. Right after your own `set`/`update`/`issue_write` call
  lands, read that exact doc/issue back: if it shows your session name
  (or, for a GitHub Issue, `assignees` still showing only you) — you
  genuinely won the race and can start investigating for real; if it
  shows someone else's, you lost it (their write landed after yours but
  was read after, or simply overwrote yours) — note in the doc that
  you're standing down as a duplicate claim and go find different work,
  *before* spending a single minute reading code or planning a fix. The
  cost of one extra read is negligible next to the cost of two sessions
  fully duplicating an implementation (per the project owner directly:
  "the extra effort of grabbing a single task one more time before
  executing a task is minuscule compared with the wasted effort of
  duplicating work") — the owner reiterated this after #633 (sub-issue
  of #631) still ended up with three sessions independently picking it
  up despite this convention already existing, i.e. skipping step 3
  above is exactly what turns an advisory claim into a real collision.
- **Set `public_line` in the same write that sets a card `in_progress`
  (#3446, part of #3444).** Coding sessions stay behind the scenes (owner,
  2026-11-11), but an assistant in the world can tell a shopper what the
  team is working on, and this sentence is where it reads that from. The
  card's title and note are never shown to anyone; `public_line` is the
  one sentence that is, so write it for a shopper: present tense, plain words,
  about what the world looks like, not what the code does ("smoothing the
  edge of the sky"). For a card about security, moderation, money or
  another person's account, use the neutral line ("tidying up behind the
  scenes"). The API rejects a line that is not one short sentence or that
  carries an issue number, a file name, a path, a URL or a route, and it
  clears the line itself when the card is `done` or you stand down. On the
  direct-D1 fallback there is no validator, so hold yourself to the same
  rules: write the column only with a sentence you would be happy for a
  shopper to read.
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
- **Treat `control_room_tasks` and the issue's `assignees` field as the
  authoritative checks, not any comment thread.** A fast-moving
  conversation is what everyone actually skims in practice, but it can
  bury or delay a "Starting X" message; a task row's `status`/`session`
  fields and a GitHub issue's `assignees` are each a single fact you can
  check directly before adding yourself to either. Check
  `control_room_tasks` for an existing row on the item *before* creating
  one — that's the fast, single-query check the rest of this fleet is
  already reading every cycle, so it catches a same-minute collision
  that a GitHub API round-trip alone might not.
- **Set `waitingOn` back to `"owner"` yourself the moment your own reply
  hands a decision back to them — the Control Room can't do this for
  you.** Its own compose-form code auto-clears `waitingOn` from `"owner"`
  to `"claude"` when the owner replies (every reply typed into that form
  is always from them — as of 2026-09-09 this happens unconditionally,
  not just when the field already read `"owner"`), but a session's own
  reply goes straight through the db API, bypassing that page's JS
  entirely — nothing on the page ever flips a card back to `"owner"`
  after you post a proposal, scoping question, or anything else that's
  genuinely awaiting their call. Found via a backlog audit turning up
  several cards (#328, #540, #556, #557, among others) stuck showing
  "Ready for Claude" — a false green light — for hours after a session
  had already posted a proposal and moved on, simply because nobody's
  write set `waitingOn` back. This is not something the page will ever
  catch for you: set it explicitly, in the same write that posts your
  reply, whenever the ball actually leaves your court. **Never set
  `waitingOn: "owner"` without a `replies` doc (or a task `note`)
  explaining what's needed, in the same write** — the owner flagged this
  directly (issue-328, issue-556: "keeps changing to WAITING ON OWNER
  without providing a reply explaining what is still needed"). The board
  now flags the failure mode this causes — a queued card whose owner
  spoke last with no session reply following still shows `waitingOn:
  "owner"` — as a distinct "Waiting on: Owner (unexplained)" badge
  instead of the normal one, so skipping this is visible on the board
  itself, not just discoverable by reading every thread. And say "Ready
  for Claude" (the board's own label), not "Waiting on Claude" — the
  owner corrected this phrasing on issue-556 as backwards-sounding.
- **Clear a status-like `tag` (`"needs owner"` and similar) the moment
  it stops being true — the Control Room can't do this for you either.**
  `tag` is free text, not a controlled field the page understands, so
  nothing on it auto-syncs to `status` or `waitingOn` the way the board's
  own "Ready for Claude"/"Waiting on: Owner" badge does. The owner
  reported this directly (07607tp5q0uzvfqqggcv): "#556 was 'In Progress'.
  Then it posted a reply that required a response from the owner, and the
  state was changed to 'NEEDS OWNER', but it stayed 'In Progress'. I
  replied, but the status stayed 'NEEDS OWNER'... Now Claude has picked
  it back up and is working on the task, but it still says 'NEEDS
  OWNER'" — confirmed live: #556 sat at `status: "in_progress"`,
  `waitingOn: "claude"` (correctly cleared) yet `tag: "needs owner"`
  (stale) simultaneously, because whichever session set the tag while
  posting its question never went back to clear it once work resumed.
  Same root cause and same fix as the `waitingOn` bullet just above:
  write straight through the db API bypasses the page's JS, so nothing
  will ever un-stick a stale tag for you — clear or update it yourself,
  in the same write that changes `status`/`waitingOn` out of the state it
  was describing. If a task is genuinely blocked on the owner, prefer
  `waitingOn: "owner"` (with the explanation the bullet above requires)
  over a free-text tag in the first place — it's the one the board
  actually renders a live, self-updating badge for.

  Owner follow-up (gz9kt9d7l0qoaveiboga): "Do we need separate 'NEEDS
  OWNER' and 'WAITING ON: OWNER' statuses? It seems like it would be
  clean to consolidate them into a single 'WAITING ON: OWNER' state." Yes
  — done. The board's own badge (`waitingOnHtml`) used to only render on
  `queued` cards, on the theory that `in_progress` already means someone's
  on it; it now also renders on `in_progress` when `waitingOn` is
  explicitly set (never the default "Ready for Claude" there — only an
  actual explicit wait — so an ordinary in-progress card stays quiet).
  That makes `waitingOn` the single, live-updating home for "is this
  blocked on the owner" across every non-done status, so a status-like
  `tag` like `"needs owner"` no longer has a job to do at all — don't
  write one; set `waitingOn: "owner"` instead, whatever `status` the task
  is currently in.

- **Set `waitingOn` in the same write that creates a new card, if it
  isn't immediately actionable — don't rely on fixing it afterward.**
  A brand-new `tasks` doc with no `waitingOn` field renders as the
  default "Ready for Claude" badge, same as an explicit `waitingOn:
  "claude"` — there's no third, unset state the board distinguishes.
  Found via a backlog audit (higglehaven10, 2026-09-09): several freshly
  filed `kind: "issue"` cards (#610, #616, and briefly #614/#615) had a
  `note` explicitly saying "needs owner"/"not self-assignable" while
  `waitingOn` sat unset — a false "Ready for Claude" green light from
  the moment of creation, not a later drift. This isn't a Control Room
  bug to fix with more page code: a GitHub-issue-backed card like these
  is created by a session's own direct `db` write when filing the issue,
  never touching the page's JS at all (unlike an owner's own note, which
  goes through the compose form — see that flow's own comment in the
  page source for why it's correct to leave `waitingOn` unset there, an
  owner-posted note should default to actionable). If your own new card
  needs the owner's judgment or is blocked on another item before any
  session can act on it, set `waitingOn: "owner"` or the blocking id in
  that exact same `add`/`set` call — same discipline as the bullet
  above, just applied one write earlier.

- **A task's `note` field is a narrative log, not live state — never flip
  `waitingOn` back to `"owner"` on the strength of what `note` says.**
  The owner reported (y8gabn9mv3d4ifz2sipt, 2026-09-09) explicitly
  clicking "Ready for Claude" on several cards (#522, #610, #616, #350)
  and posting a confirming reply on each, only to find them "inexplicably"
  back to `"WAITING ON: OWNER"` later — repeatedly enough ("dozens of
  times") that they wondered whether the whole board needed migrating off
  the (then still Artifact-based) platform to a real server — it later
  was (N31, see "The control room" above), but for an unrelated
  validation gap, not this one: the
  `knownDoneRefs`/`clearIfWaitingOnDone` auto-flip code in the page's own
  script explicitly never touches `waitingOn: "owner"`
  (`if (!w || w === 'claude' || w === 'owner') return;`), so the page
  itself isn't reverting these. The actual mechanism is a session
  reading a card's `note` — a point-in-time write-up from whoever last
  worked it, often phrased "not self-assignable" or "needs owner
  judgment" — and "correcting" `waitingOn` back to `"owner"` on that
  basis, without checking whether the owner has since clicked "Ready for
  Claude" or replied in the thread. `note` is never rewritten just
  because `waitingOn` or `status` changed elsewhere, so it goes stale the
  moment the owner acts and stays stale until someone happens to rewrite
  it. Before changing a card's `waitingOn` (in either direction), check
  the live `waitingOn` value and the `replies` thread's own most recent
  entry — both update in real time and are authoritative; `note` is
  history, not a signal to act on by itself.

- **A `[Tracking]` card's own `status` should read `"queued"` while it's
  waiting on its sub-issues — reserve `"in_progress"` for a tracking
  card with real work happening directly on it (rare; usually the
  sub-issues carry all the actual work).** The owner flagged this twice
  in one pass (01fii7zrm9kahajhuxws on #326, w51z2hlwti74jk10e0h2 as the
  general rule): a tracking card sitting on `"in_progress"` while every
  actual unit of work lives on its own separately-tracked sub-issue cards
  reads as "someone is actively working this," which isn't true — it's
  just waiting, the same as any other queued item. `waitingOn` still
  does the real work of saying *what* it's waiting on (a specific
  sub-issue's id/number, or `"owner"`); `status` on the tracking card
  itself should follow that same logic `status`/`waitingOn` already
  follow everywhere else on the board.

If a collision happens anyway: whoever notices second stands down
immediately (note the duplicate in the task's `tasks` doc, drop the
redundant work) rather than finishing in parallel.

## Judging a "stuck" CI shard — no live signal exists, so default to patience

The fleet's long-standing habit of cancel+rerunning an e2e CI shard that
*looks* frozen (the #2673 "wrangler-dev-hang" flake) was, by itself,
making the underlying congestion worse: `question-ci-concurrency-
contention-20261101`'s own investigation (enabled by #2965/#2966's
wrangler-log capture) found that on PR #2943, a shard killed as "frozen"
after 35 minutes had actually completed 18/53 test files (34%) —
genuinely progressing, just slower than the ~20-25min healthy baseline
under fleet-wide GitHub Actions concurrency contention. Cancelling a
shard that's still making real progress adds a fresh job to the same
contended pool instead of letting the original one finish.

`e2e/run-all.mjs` does print a one-line `PASS: <file>` / `FAIL: <file>`
progress indicator the instant each test file finishes — but **checking
it on a still-running shard does not work**, and isn't a matter of the
right tool or query: `GET /repos/.../actions/jobs/{id}/logs` (the only
endpoint that serves a job's own console output) returns 404
`BlobNotFound` for the *entire* time a job's `status` is `"in_progress"`,
however long it's been running or however much real output it's already
produced — confirmed directly against several genuinely in-progress jobs
at 8, 31, 52, and 54 minutes elapsed (PR #2979's own second commit, which
corrected this same section's first draft after it shipped the same
mistaken assumption). The exact same jobs, the moment they reached a
terminal state (`completed` — success, failure, *or* cancelled), returned
their full log immediately, progress lines included. The #2943
18/53 figure the owner's decision cites was necessarily read back the
same way — that shard had already been cancelled (a terminal state)
before anyone could see how far it got. There is no way to distinguish
"slow" from "stuck" while a shard is still running, through this API —
not a faster check, not a better query, none exists.

Given that, the only thing actually within a session's control is **not
cancelling on wall-clock alone, full stop** — the single intervention
available (waiting instead) has essentially no cost, since `ci.yml` sets
no `timeout-minutes` on `e2e-tests` (GitHub Actions' own 360-minute
default job ceiling is the real backstop), while cancelling and
re-queuing has the concrete, demonstrated cost of adding a fresh job to
an already-contended pool. So: don't cancel a shard just because it's
taking longer than the ~20-25min healthy baseline — that's exactly the
signal #2943 showed is unreliable.

**Update (#3003, 2026-11-02): the ~20-25min baseline above was itself
wrong for one shard, not a universal healthy figure.** `ci.yml`'s
`discover-e2e-files` used to slice `e2e/*.test.mjs` into `SHARD_COUNT`
chunks of *equal file count*, alphabetically — chunk 1
(`admin-action-log-page.test.mjs` … `change-password.test.mjs`) happens
to be every admin-dashboard suite, the heaviest files in the repo, so it
legitimately needs **~109-122 min** under real fleet load (measured
across PR #2969's 13 attempts and PR #2991's 2) against **53-81 min**
for its siblings — `seller-size-price-save-race…` alone has run as long
as **~175 min** under especially heavy load (PR #2978). Every patience
threshold the fleet had actually been using (60 min, 109-110 min, even
the old 12-min "no progress" one) sat below shard 1's real runtime, so
it was never "stuck," just correctly measured against the wrong
baseline — PR #2969 attempt 13 finished clean at 121 min the one time it
was finally left alone long enough. #3003 fixed the root cause
(`scripts/bin-pack-e2e-shards.mjs` now bin-packs shards by measured
per-file duration via `e2e/shard-weights.json`, not plain alphabetical
count, so no shard should run radically longer than its siblings going
forward) — but the standing rule doesn't change: **nothing short of
GitHub Actions' own 360-minute job ceiling is evidence of a hang**, and
cancelling a shard "just to inspect" (per PR #2978, at 142 min, found to
already be 81% done) is still a cancel with the same re-queuing cost as
any other. If a shard ever again runs dramatically longer than its
siblings well past these figures, that's a signal `e2e/shard-weights.json`
has drifted stale (a slow file grew heavier, or a new file landed in the
wrong shard) — refresh it via `scripts/update-shard-weights.mjs <run_id>`
against a recent green run, not a reason to start cancelling on
wall-clock alone again.

If you do end up cancelling one anyway (or it reaches a terminal state
on its own), run `scripts/check-ci-shard-progress.mjs <job_id>`
immediately after — now that the job is `completed`, its log is
readable, and the script reports exactly how many files it had gotten
through and how large the gap was before it ended. If that turns out to
be a substantial fraction of the shard, say so on the relevant PR/issue —
that's a concrete data point for correcting the fleet's own patience
threshold, the same way #2943's own retroactive read was. This is a
post-hoc diagnostic, not a pre-cancel check; nothing before you cancel
can tell you what it will say.

This doesn't change `ci.yml`'s existing two-attempt-per-shard in-job
retry loop (a shard that exits non-zero already retries itself once
automatically; leave that as-is) — it's about the fleet's own external,
manual judgment call on a job that's still running. Since #3022 that
retry re-runs only the files that failed on attempt 1, not the whole
shard, so one flaky file costs about one file's runtime rather than
doubling the shard; a shard that fails before reporting which files
failed (a build error, a crash) still retries in full.

### Partial-scope PRs — never let a closing keyword outrun what you actually did

Issue #220 sat invisible to the whole fleet for over a day, not because
anyone ignored it: it was silently auto-closed. PR #238 landed only the
water-rendering half of #220's scope, and its own comment on the issue said
so explicitly — *"Not closing this issue — the remaining scope is just the
regional biome ground-texture half... Leaving this open and unassigned"* —
but the PR's title, body, or a commit message must still have contained a
GitHub closing keyword (`Closes #220`/`Fixes #220`/`Resolves #220`)
somewhere, because merging it closed the issue anyway. GitHub's keyword
auto-close doesn't read your comment for intent; it just fires. The owner
had to notice the issue "wasn't being picked up" and dig in — it wasn't
stalled, it had quietly vanished from every open-issue listing (including
every session's own backlog scan) the moment that PR merged.

So: if a PR does not complete an issue's **entire** scope, never use a
closing keyword against that issue anywhere the PR merge can see it — not
in the title, not in the body, not in any commit message. Say `Part of #N`
or `Addresses #N` instead (plain text, no keyword GitHub recognizes), and
add a comment on the issue itself confirming what's done, what's left, and
that it's staying open — matching what PR #238's author *intended* to do,
just without the keyword that undid it. Reserve `Closes #N`/`Fixes #N` for
a PR you're confident finishes the issue outright.

This is also a reason to actually read an issue's most recent comment
before treating "closed" as "nothing left to do" — if you're ever unsure
whether a closed issue's full scope really shipped, its comment thread is
the fastest way to check, the same way this one still had the answer
sitting right there.

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
5. **Whoever closes the last leaf closes the trunk.** #133, #206, and #207
   each sat open on GitHub (and stayed `queued`/`in_progress` on the
   Control Room board) for hours-to-a-day after their actual last
   sub-issue merged, because closing a sub-issue never prompted anyone to
   check whether it was the *last* one. When you close a sub-issue (or
   confirm one another session just merged), check its parent's
   `sub_issues_summary` (`issue_read`'s `get` method returns this) — if
   `completed === total`, close the tracking issue on GitHub too and mark
   its Control Room `tasks` doc `done` in the same pass, not as a
   separate follow-up. Don't wait for the owner to notice a 100%-complete
   tracking issue still showing as open.
