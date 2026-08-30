# higglehaven — Specification Document (v15)

*Renamed from Shoplándia (v9) after a full IP clearance check (USPTO, WIPO, WA Secretary of State, domain, social/marketplace platforms) found real collision risk with the "Shoplándia" name and confirmed "higglehaven" clean across all checks. Naming convention unchanged: plain "a" internally (code, files, DB, APIs — `land`, `landlet`, `daller`), á reserved for customer-facing display only.*

*Status: the original spec-completion checklist (7 areas, S31) is functionally complete. Remaining open items are listed in §10 — as of this version: lándlet hosting cost validation and Runbot LLC account ownership (leaning, not final). All other previously-open items have been resolved.*

---

## 0. Origin, Umbrella, and Philosophy

- Operates as a **registered trademark of Runbot LLC**, not a separate entity — chosen for tax-loss-netting (higglehaven's early losses offset Runbot's profit on one consolidated return) and reduced admin overhead. Revisit with a CPA if higglehaven's risk profile grows enough to justify liability separation later.
- **Founding philosophy, stated explicitly on the higglehaven about page, not buried in ToS:** fairness, freedom, equality. No preferential placement for volume or ad spend. Growth is earned through demonstrated performance, never purchased with outside capital.
- **Development philosophy (the "log home parallel"):** built solo, direction and vision entirely yours, using AI coding agents as accelerating tools ("a more capable chainsaw") rather than a technical co-founder who would bring their own taste and priorities. AI agents execute; they don't decide.
- **Competitive positioning:** closest analogues are VRChat (strong social, no commerce) and Decentraland (commerce, poor social, blockchain-speculative land that produced a mostly-empty world because capital could buy land regardless of contribution). higglehaven's no-cash-to-dáller-conversion and performance-earned land cap are a direct, deliberate structural correction to Decentraland's failure mode. Roblox is the closest real precedent for the currency model.

---

## 1. World Architecture & Rendering

**Engine:** Three.js (WebGL) for the prototype/MVP. Designed migration path to Unity WebGL as the platform scales; Unreal+Pixel Streaming rejected as too server-cost-heavy for this stage.

**It's a website, wrapped for app stores later** (Capacitor/Electron-style), not a separate native codebase — same strategy Roblox itself uses.

**Scale (corrected):** 1 virtual unit = 1 real **meter** (not foot). A standard 1,000 m² lándlet plot is roughly 31.6×31.6 m if square (irregular puzzle-piece plots vary). World built on an **Earth-curvature coordinate system from day one** (not a flat plane) — avoids a painful future migration.

**Coordinates:** floating-point decimal meters (1.0 = 1 meter), not integers.

**Land shape:** irregular, interlocking puzzle-piece tiling with freeform, nature-like curved boundaries; no grid, annular plot bands, or visible border geometry. A boundary is authoritative shared geometry used by both neighbors (never two independently generated approximations), while the visible "border" is purely stylistic contrast between neighbors.

**World boundary — circular expansion model (supersedes earlier "amoeba" adjacency-based growth):**
- The explorable world is a clean **circle**. Radius grows in fixed **10-meter increments** whenever greenbelt-lánd count falls below **10% of total lánds**. **(v15 addition) Now built literally, not just conceptually:** a Cloudflare Cron Trigger checks this exact condition on a schedule and grows the world automatically — see docs/API.md's "Automatic world growth." Previously this was only a player-triggered dev-mode stand-in (a "Grow the world" button shown when nothing was claimable); that button is retired now that the real mechanism this section always described actually exists.
- Any lánd fully enclosed by the circle automatically becomes greenbelt-available, regardless of adjacency to claimed land — eliminates a chaining exploit and the resulting maze-like perimeter.
- The circle is an availability boundary, not a generation or tiling boundary. A lánd may cross it: its complete puzzle-piece shape is decided and stored, but it cannot be selected until the circle fully encloses it. Expansion therefore promotes already-generated crossing lánds rather than clipping them to a new ring.
- After each 10-meter expansion, generation fills newly exposed blank space with complete neighboring puzzle pieces. Those pieces may extend beyond the current circle so the next expansion can reveal established shapes without gaps or boundary-dependent reshaping.
- **Generation timing (corrected):** a lánd begins generating the moment the expanding circle **first partially overlaps** it — not only once fully enclosed. This avoids a real gap in the original "on-demand at full inclusion" design: as the circle grows, lánds on the advancing edge would otherwise have zero lead time to generate before players reach them. While generating (partially overlapped but not yet fully enclosed), a lánd displays as **shimmery, walkable/flyable, but not yet claimable** — claimability only activates once the circle fully encloses it. This preserves the "on-demand, not speculative" principle while giving each lánd real generation lead time.
- World-wall shimmer marks the circle's exterior; this same shimmer treatment applies to any lánd still mid-generation per the above.

**Chunk loading:** near band = full 3D geometry; middle band = simplified LOD; far band = a **pre-rendered flat panoramic backdrop image** per region, regenerated offline (daily or on major changes) — primary anti-pop-in strategy. Fog is now secondary/supplementary, blending the middle/far seam.

**Macro-geography:** real, permanent geographic features (lakes, rivers, mountains, biomes) laid out once, early, deliberately. **Water cannot be owned**; shoreline lánds are highly coveted once circle-exposed (anticipated organic "gold rush," e.g., near the real Lake Washington).

**Geographic authenticity rule:** recreate natural pre-human Earth geology (exclude man-made terraforming like canals/mining pits) but populate with **present-day flora** including non-native species — no historical reconstruction. Canonical example: Lake Washington and Puget Sound render as their actual pre-1916 separate water bodies (before the man-made Montlake Cut) — an intentional discoverable detail.

**Vertical construction — tied to land cap, not a separate resource. Correction (P143): cap consumption is asymmetric, not identical above/below ground.**
- The earlier "below-ground levels count identically to above-ground levels" rule was flat-world thinking and is **wrong at the geometric level** once Earth curvature (already a confirmed §1 world-architecture decision) is taken seriously. A fixed-angular-footprint lánd extended radially through the Earth is a **cone converging on Earth's center**, not a cylinder.
- **Correct model:** each level **above** ground consumes *increasingly more* land cap per level (cross-sectional area grows moving away from Earth's center); each level **below** ground consumes *increasingly less* land cap per level (area shrinks toward the center).
- The difference is imperceptible at any near-term realistic scale, but the underlying world architecture must be built correctly from the start.
- **Hard depth limit:** Earth's radius — a builder physically cannot dig deeper than the planet's core, though reaching that limit is essentially impossible in practice.
- **Minimum viable footprint:** once a downward level's cross-sectional area would fall below **10 m²**, the builder is blocked from going any deeper (prevents pointless infinitesimal levels).
- No gaps between adjacent lánds at any given level (including level 10+), and no overlap at deep below-ground levels — the cone geometry must be modeled precisely enough to guarantee this.
- HOA rules are the only mechanism for a lower ceiling than cap otherwise allows.
- Removing a level frees consumed cap immediately.
- Vertical chunk-loading uses the same near/middle/far LOD banding as horizontal distance.
- **Terminology note:** there is no clean single-word metric equivalent to "square footage" — use "area in square meters" or "minimum floor area of 10 square meters" rather than inventing a "square meterage" term.

**Day-night cycle — removed, at least for now (v11 correction):** the earlier shared, compressed 4-hour cycle (1 hour each: daylight, dusk, night, dawn) is removed. A dark "night" phase read as ominous rather than the lighthearted, bright, whimsical feel this world is going for, and cycling through three different lighting conditions put an unreasonable burden on every builder to make their space look good under all of them. The world is fixed at permanent bright daylight instead. Revisitable later — this is a brand-direction call, not a permanent architectural one.

**Visual brand direction (v11):** lighthearted, whimsical, and very bright — the explicit antidote to anything that reads as ominous or heavy (see the day-night removal above). Primary palette: pale green and pale yellow, with other soft (not saturated/harsh) colors in support. UI chrome is clean, minimalist, and simple, using expanding/collapsing menus to keep persistent on-screen chrome to a minimum — the world itself, not the interface around it, should occupy the screen.

**Login/spawn:** unauthenticated users see a **generic, non-higglehaven-world branded screen** — NOT the in-world aerial rotating view, reserved for *after* age/payment verification (a deliberate child-safety-conscious sequencing choice, §8). Post-verification, both new and returning users see a **slow clockwise rotating aerial shot at a random location** each login. "Last Location" is offered as a choice, not automatic default.

**No portals, ever** — flight is the sole means of long-distance travel.

---

## 2. Avatar System

**Default avatar:** a single, standard, deliberately non-gendered avatar assigned instantly at registration. No forced gender-disclosure step.

**Aesthetic policy — full spectrum, cartoonish to photorealistic**, no enforced house style — a deliberate extension of "variety and self-expression as the actual design language."

**Technical requirement:** unified skeleton/animation rig across all styles regardless of surface mesh/texture. Avatar LOD-at-distance is a post-MVP refinement.

**Idle/interaction animations:** context-aware idle state machine (sit, lean, stand) after inactivity, with randomization. Item-handling animations trigger on sustained view-attention (pick-up-and-turn for small items, walk-around for furniture-scale).

**Movement:**
- Walking: 1.8 m/s. Running: 2.2 m/s.
- **Flight:** double-tap jump (mobile) / double-press spacebar (desktop). Takeoff ~1s lift + ~1s fade to invisible. Landing: ~2s reverse fade; occupied landing spots offset to nearest open space.
- Altitude/speed: **logarithmic** — each doubling of altitude ≈ 50% more max ground speed, diminishing at extremes. ~10x walking speed near building-height, up to ~100x at max altitude (~500m).
- Flying avatars are invisible to other users.
- **210-degree rotational offset** applied once during real-world-to-higglehaven coordinate mapping — permanent, zero-cost, thematically resonant detail.

**Collision (crowding) — confirmed numbers:** a **2-foot-diameter hard barrier** (avatars cannot overlap closer than this) surrounded by a **1-foot-diameter zone of increasing push-back resistance** as an avatar moves further into it — soft at the outer edge, firmer approaching the hard barrier. (~0.6m hard barrier + ~0.3m soft zone in the platform's internal meter-based units.)

**Voice — confirmed numbers:** **100 feet (~30m) of complete silence** as the outer range, with volume ramping up gradually as avatars get closer — not a hard cutoff, and not full volume at max range either. Deliberately balances realism (a crowded area shouldn't be eerily silent) against practicality (avoiding overwhelming noise in dense areas). Text chat available as an alternative. Group voice channels for friends regardless of proximity. Direct messaging requires the higher (ID-verified) trust tier.

**Social presence signals:** sustained attention on an item emits a subtle "engaged" signal to nearby avatars. Stationary-too-long triggers an AFK indicator.

**Group movement:** "follow"/"stay with" toggle — a friend's movement (including flight) auto-tracks near another's position, full manual override at any time.

---

## 3. Builder Tools & Plot Management

**Universal builder status:** every user is automatically a builder — no separate account types. Every signup can claim **one free 1,000 m² lándlet**, at their discretion, **chosen freely by the builder from any available greenbelt lándlet** (corrected from an earlier random-assignment model — no identified downside to letting new builders pick their own starting spot). **(v14 addition) Now built literally, not just conceptually:** signing up for a real account (§6's login) automatically provisions a linked builder profile — see docs/API.md's "Builders." A seller profile stays deliberately lazy/opt-in instead, provisioned only on first entering Sell mode, matching this section's own "quite apart from whichever builder identity is active" framing below. Build and Sell mode both now require a real, logged-in account to enter at all — the old free-text dev-mode identity picker is retired.

**Land size distribution — power-law, confirmed authoritative (supersedes any other stated ratios):**

| Class | Size Range | % of Lánds |
|---|---|---|
| Lándlet | 1,000 m² (exact) | 90% |
| Class 2 | 1,001–10,000 m² | 9% |
| Class 3 | 10,001–100,000 m² | 0.9% |
| Class 4 | 100,001–1,000,000 m² | 0.09% |
| ...continues... | (each class 10x the range, 1/10th the population) | ... |

- Population rounds **down**; leftover allocates to lándlets.
- Within-class size drawn from a **uniform distribution** (not a nested power law).
- Validated math: a single mega-lánd (1,000 km² class) requires a population near **10 million total lánds** — a distant, deliberate future milestone.

**Land cap — the growth-gating mechanic (distinct from land acquisition, §5):**
- Per-builder max total m², gating hosting burden.
- Grows via a formula converting **trailing-30-day dáller earnings per 1,000 m² owned** into cap increases.
- **Ratcheting:** once increased, never decreases.
- Conversion ratio adjusts **at most once/month, small increments**.
- **Cascading increases are real, intentional, and uncapped** (corrected — an earlier 5,000 m²/30-day ceiling on cascading cap growth is removed). A builder or auction-savvy trader who genuinely performs exceptionally well should reap the full reward; since cap growth is directly tied to demonstrated higglehaven revenue either way, uncapping this doesn't create a hosting-burden risk independent of what's already been earned.
- Estimated cost basis: ~$0.10–$0.50/month hosting per lándlet; trigger of **$3–$5/month lándlet revenue** gives ~10x cost coverage. [Needs validation against real measured costs once live.]

**Two independent constraints (do not conflate):**
1. **Land cap** — how much total area, grows only via earnings formula.
2. **Dáller balance** — which specific already-claimed lánds can be acquired via auction (§5). Never purchasable with real cash.

**Coordinate system within a plot:** floating-point meters, origin at plot center (polygon centroid, snapped to nearest interior point for irregular/concave shapes).

**Build tools — both modes, freely combinable:**
- **Prompt mode:** natural-language description → AI generates a concept image → queries product database via **visual embedding similarity search** (CLIP-style) to place real, purchasable items approximating it.
- **Manual mode:** direct search/drag-and-drop with standard 3D manipulation controls (transform gizmo) — replicate conventional Blender/Unity conventions.
- **Alignment assist:** snap-with-escape model — transient guide near an alignment opportunity, continued movement releases it, pausing commits it. Conservative starting threshold, tune via playtesting.
- **Overlap handling:** permissive by default. AI flags only visually *broken*-looking overlaps, not intentional/concealed ones. Builder can dismiss or disable.
- **Item placement physics:** fully permissive (float, embed, rest — builder's discretion). Shopper collision still prevents walking through items.
- **Bundles** (confirmed term): group items to move together. Private by default; explicit opt-in sharing to a community bundle tab.
- **Draft/publish + version history:** preview from shopper's perspective before publishing. Every save = a version snapshot; active version = a pointer. Toggle between saved versions **from within the live shopping interface**, with explicit confirmation before activating a different version.
- **Version-change transition (shoppers present):** old items fade/shrink into ground, new version's items fade/grow up — ~2–4 second animated transition.

**Performance budgets (starting hypothesis, validate empirically):**
- ~10–25 MB total model+texture data per average lándlet; density cap ~1–2 MB per cubic meter concentrated.
- **Automated mesh-merging on save:** builder edits fully individual objects; platform auto-generates an optimized merged mesh for delivery (reduces draw calls) — standard "source vs. build" pipeline pattern.
- Standard pipeline: **GLB** format, CDN delivery, Draco geometry + Basis Universal texture compression, automatic multi-LOD generation.

**No HOA / community-rule governance layer (removed entirely).** The earlier opt-in HOA-style voting system is eliminated in favor of unqualified creative freedom. If a builder dislikes a neighbor's aesthetic, their recourse is to relocate — not to vote it away. higglehaven explicitly embraces the aesthetic outlier over conformity (the stated internal reference point: an Edward Scissorhands house standing out among a row of uniform 1960s pastel homes is treated as *beautiful*, not a problem to solve). No mechanism exists for majority preference to override an individual builder's creative choices on their own lánd.

**Ground/flooring as real product:** default grass texture is placeholder; placing a specific real flooring/sod product replaces it within that footprint.

**Founding/pioneer recognition (corrected — no size advantage):** permanent "Pioneer" profile badge (grows in prestige over time) and a permanent "founding history" page (the "nail-chalice" — improvised from limited catalog — preserved as founding lore). **Explicitly no larger starter plot for founding builders** — with a sparse early builder community, an oversized early lándlet would let founders claim what becomes prime real estate later purely by being first, undermining the platform's performance-earned (not first-mover-earned) growth philosophy. Recognition stays reputational/historical only.

**No higglehaven-managed central plaza** — superseded by the circular growth model: the platform's own first-ever claimed lánd (yours) naturally occupies that position organically. New users spawn zoomed-out in flight mode above the world.

---

## 4. Product Database & 3D Model Pipeline

**Prohibited categories (baseline, eBay/Etsy-referenced):** weapons capable of serious harm, controlled substances/paraphernalia, adult content, counterfeit/unauthorized trademarked goods, live animals.

**Digital goods — narrow, conditional exception (supersedes earlier "excluded by default"):** permitted if the listing includes (a) a representative 3D model and (b) a clear higglehaven-controlled disclaimer of what's actually delivered. Examples: digital gift cards to real businesses, digital art/print files, higglehaven-ecosystem software tools.

**Services:** excluded from v1; reconsider for v2.

**Sourcing — hybrid strategy (three-path decision resolved):**
1. **Direct seller upload** (photogrammetry from 4+ photos or 360° video) — cleanest, slowest to bootstrap.
2. **Affiliate/marketplace partnerships with written permission** — critically, **not scraping**. Scraping retailer photos/data without agreement is real legal exposure (ToS violation, potential CFAA issues). Requires the formal **marketplace/reseller API partnership** tier (distinct from a basic consumer affiliate program) — only that tier permits unified-checkout/drop-ship-style fulfillment.
3. **Crowdsourced model generation:** contributors submit 360° video of items they own/have rights to; ~$0.01/model economics, **paid only on passing an automated quality gate**.

Near-term bootstrap: hybrid affiliate-with-permission + selective crowdsourcing, supplemented by **personally modeling urgently-needed infrastructure items** (sod, siding, roofing).

**3D model generation cost (researched):** ~$0.10–$1.00 per model; realistic budget for a first ~10,000-item catalog with iteration: **~$5,000–$8,000**, one-time.

**Legal/IP:** models from direct seller uploads are cleanest. Models from affiliate/scraped retailer photography **without explicit permission are legally murky** — use placeholder primitives until permission/licensing exists.

**Metadata schema (minimum per item):** category, subcategory, color, dimensions, price, seller ID, visual embedding vectors.

---

## 5. Commerce, Land Acquisition & Auctions

**Universal commission formula:**
- higglehaven takes a total fee (2% standard for seller-listed products — undercutting Etsy ~9.5%, Amazon 8–15%, eBay 10–13%; explicit seller-recruitment advantage).
- **Universal 50/50 split** of whatever commission higglehaven receives: 50% higglehaven, 50% Builder — applies identically to seller-fee or affiliate-commission revenue, with a **0.5% floor** protecting builders on low-commission affiliate products.
- Concrete example ($100 sale, 2% total commission): **Seller keeps $98, Builder earns $1, higglehaven retains $1.**

**Checkout — unified, in-app:**
- A single order can span multiple sellers/retailers; higglehaven is merchant-of-record, fulfills behind the scenes via marketplace/API partnerships.
- **Combined shipping savings pass to the seller** (actual combined cost used, not summed estimates) — simple, honest, no incentive to favor large sellers.

**International shipping:**
- **Dimmed-filter approach:** shoppers toggle a filter; non-shippable items are dimmed with a label ("ships to United States only"), not hidden.
- **Seller sets shipping cost by destination zone** — not a fixed "non-domestic party pays" rule. "Free shipping" branding preserved uniformly.

**Payout timing:**
- **Dállers credit instantly** to builders on sale completion.
- **Seller cash withdrawal tiered by trust/track record** (not flat 30-day): new sellers face a standard hold (~14–30 days), trusted sellers with dispute-free history earn progressively faster access.
- **Returns/refunds return real currency, not dállers** — via Stripe Connect's built-in marketplace refund tooling. **Requires a dáller-commission clawback mechanism** (builder's instant commission on a returned sale is deducted, potentially creating a negative balance to settle).
- **No-returns-policy respected as seller-set default**, within baseline fraud/dispute protections.

**Land acquisition — simplified auction system (supersedes earlier multi-phase English+Dutch design):**
- Default **24-hour duration** for inactivity-triggered listings; builder-initiated voluntary auctions may set custom duration.
- **Starting bid defaults to $0** (no calculated-value formula, no reserve price) — reserve prices are "functionally dishonest."
- **A $0 starting bid = explicit willingness to relinquish for free if no bids arrive.** A ≥$0.01 starting bid = builder wants to retain if unsold; that lánd is NOT greenbelt and land cap is not freed. **Land cap frees once a bid occurs** (any bid guarantees eventual transfer) **— or immediately if the builder set $0 and committed to unconditional relinquishment**, resolving the "free capacity before a slow auction resolves" problem.
- Dállers raised in a successful auction go to the previously-inactive builder's account, in case they return.
- "Greenbelt" is a **status flag on any lánd**, not a fixed geographic region.

**Cash economy — four settled pillars (state explicitly on the about page, not just ToS):**
1. **Dállers can never be purchased with cash** — only earned via demonstrated commission. Direct correction to Decentraland's speculative-capital failure mode.
2. **Land cap grows only via demonstrated performance**, never purchasable.
3. **Dáller-to-cash redemption is phased**, purely for technical/regulatory sequencing. Priority order once redemption begins: **tax-payment facilitation first** (narrowest scope — convert exactly what's owed in tax), both the most urgent real need and the safest first regulatory step.
4. **No monetization beyond the commission split** — no premium features, no ads, no higglehaven-operated commercial lánds. The greenbelt specifically is framed as higglehaven's deliberately uncommercial "park."

**Multi-currency Dállers:** internally tracked in **USD as single source of truth**; display/redemption currency user-selected, converts live via Stripe's built-in FX (stays outside SEC/money-transmitter territory — display/payout conversion via an established processor, not currency trading as a service). "Dáller" is the **USD-specific variant** of a broader naming convention (yen/euro equivalents left as an open, potentially crowdsourced creative exercise).

**Fraud/dispute defense (layered, standard-practice):**
- Primary: behavioral/identity overlap detection between buyer/seller accounts (payment method, address, device fingerprint) against self-dealing.
- Low-value disputes from established accounts: auto-resolved in buyer's favor.
- Higher-value/new-account disputes: require actual evidence.
- Reputation system as long-term economic deterrent.
- **Counterfeit handling** uses the same framework: fast removal on credible flagging, automatic refund, strike/penalty scaled to isolated-error vs. deliberate-pattern.
- **Participation/referral rewards capped by design:** fixed pre-funded pools per period, percentage-of-realized-revenue bonuses (never flat guaranteed amounts) — mathematically bounded.
- **Review incentives:** small dáller bonus for genuine, substantive reviews, capped per account/period. **Reviews require a verified purchase (v12 clarification):** standard marketplace practice — only a shopper who actually bought the product can review it.

---

## 6. Social Features & Communication

**Friend/group systems:** standard friend requests; social map shows friends' *approximate* location (not exact coordinates). "Follow"/"stay with" toggle for group movement (§2).

**In-world social feed — physical sign-post system (no flat 2D UI layer, ever):**
- Builders flag any placed object as a "community sign" — becomes a content-bearing slot.
- Shopper-authored posts fade in/out based on proximity (size/opacity as a function of distance) — zero explicit clicking required.
- Builder controls the sign's physical form and moderates.
- **Community calendar reuses the identical pattern**, builder-authored (event postings, creative-tool support like a scheduled confetti-cannon trigger).

**Age verification & platform safety (layered, resolved):**
- **Registration requires age attestation plus EITHER a credit card (resolved: credit specifically, not debit or prepaid) OR full government-ID verification.** Debit and prepaid cards are excluded from the card path because they're realistically accessible to minors in ways a standard unsecured personal credit card isn't — youth banking products (debit cards tied to a parent's account, marketed for children as young as 6-8) and cash-purchased prepaid cards (no age check at purchase) both undermine the age signal a card requirement is meant to provide. Requiring credit specifically no longer creates an equity problem, since ID verification remains a full zero-friction-cost alternative for anyone without a credit card.
- **Full social features (voice, messaging, direct communication) require government-ID verification specifically** — if a user already completed ID verification at registration (via the path above), that satisfies this tier automatically; no redundant re-verification.
- Operator personally never communicates directly with users — a standing personal commitment independent of automated verification performance.
- Behavioral-analytics minor-detection as a supplementary layer.
- **Attorney consultation is a Day-One prerequisite.** ToS explicitly prohibits under-18 use and any attempt to contact/meet minors via the platform.
- **Login sequencing (deliberate child-safety design choice):** the branded in-world aerial rotating-view experience is placed *after* the age/verification gate, not before — "gate first, then build the experience," applied wherever sequencing can trivially support it.
- **Real account login (v13 addition):** email + password, the mainstream-standard baseline (docs/API.md's "Authentication") — the technical account layer this section's age/ID-verification requirements will eventually gate. The age-attestation-plus-credit-card-or-ID-verification requirement above is real-launch policy, not yet built (it needs a real ID-verification/payment-processor integration this dev-stage backend intentionally doesn't have yet); today's signup only proves a real, verified email, not age or identity.

**Customer service & dispute contact — confirmed no-personal-contact architecture (P122):** given the no-contact-with-minors requirement and the genuine difficulty of guaranteeing an AI system draws that line perfectly in live conversation, **all higglehaven customer-facing contact (support, disputes, complaints) must route through a third-party customer service outsourcing agency (or, once affordable, an actual employee) — never through the operator personally, and never through an AI agent using the operator's own accounts/credentials.** This is a firmer, more conservative stance than a "manual review" approach: the outsourcing agency is explicitly preferred over an AI-agent-only solution *specifically* because a CCO or ISRB reviewer could reasonably view an AI agent as an extension of the operator, whereas a genuinely separate human agency is unambiguous. Applies to: dispute resolution contact (§5), the sign-post/community-feed moderation escalation path (§6), and any higglehaven-brand social media presence — the confirmed policy there is **manual posting of AI-generated content only, with zero engagement of any kind with other users' comments, messages, or posts**, even at real cost to organic growth strategies that depend on engagement.

**Runbot's role in higglehaven:**
- Runbot's core Protocol-voiced identity is preserved everywhere. In the higglehaven assistant-guide context specifically, Runbot uses a **contextual register-shift** (warmer, more exclamatory, same underlying character and values) — **Path B, now confirmed** (people naturally shift register based on environment; this reasoning was found persuasive and settles the question). Visually distinguished from the personal Runbot-brand-shop-owner avatar (default assistants wear a collared "higglehaven" shirt; the personal shop account does not).
- **Account ownership — leaning toward Runbot LLC (not yet final).** The working assumption is shifting from "James Day as personal account owner" to **Runbot LLC as the account holder** for Runbot's own higglehaven seller/builder presence: this would make builder commissions and seller income LLC revenue (offsettable against losses/capex, per §0's tax-loss-netting structure) rather than personal income requiring distribution. Still flagged for CPA review as a technical owner-self-dealing transaction regardless of which entity holds the account — the lean toward LLC ownership doesn't remove the need for that sign-off, and raises an adjacent open question about mixed personal/business purchases on the same account (see §10).
- **No forced funneling:** Runbot merchandise stays available on the standalone Runbot website/Shopify store; higglehaven access is never a precondition. higglehaven's shop is an additional, opt-in "pull" channel.
- Runbot's music is a purchasable digital product in his shop, and optionally selectable by any builder as ambient soundtrack — never played as unsolicited platform-wide background audio.

---

## 7. Tax, Legal & Compliance

**Dállers are taxable income at the time earned**, per IRS virtual-currency-as-property framework — regardless of whether spent or converted. A builder earning 10,000 dállers has received $10,000 in ordinary taxable income (same principle as vested-but-unsold employee stock).

**higglehaven's reporting obligations (standard marketplace practice):**
- **W-9 collection timing (resolved recommendation):** requiring a W-9 at signup, before a builder has earned anything, is a real barrier to entry for casual builders who may never approach the $600 reporting threshold — and given dáller-to-cash redemption is itself phased in slowly (§5), there's little practical urgency to front-load this. Recommended approach, matching standard practice on comparable marketplace platforms: **trigger the W-9 requirement once a builder's cumulative trailing earnings reach a threshold comfortably below $600** (e.g., $500), with advance notice, pausing further commission crediting (not confiscating already-earned dállers) until submitted. This clears the compliance requirement before the $600 threshold is ever crossed, without gatekeeping casual/small builders from participating at all.
- File **Form 1099-NEC** for any builder paid ≥$600/year; failure risks $50–$290/form penalties.
- Collect **Form W-8BEN from foreign builders**; may need to withhold 30% absent one.
- **No obligation to ensure foreign builders declare earnings to their home country** — same standard as Amazon's marketplace sellers.

**The core tax-exposure risk (why cash-out sequencing matters):** a builder in a low-income country could owe real-currency tax on dáller earnings vastly exceeding prior real income, with no way to pay if cash redemption isn't yet available in-region — genuine harm-avoidance, the stated reason tax-payment-facilitation is the first redemption use case (§5).

**Tax education (not advice) — the "drowning metaphor" principle:** disclaiming legal liability is fully separable from making a genuine good-faith effort to inform. Planned implementation: **jurisdiction-keyed, plain-language, regularly-updated general informational summaries**, explicitly not personalized advice, human-reviewed before publishing, prioritized by expected builder geography.

**Runbot's own higglehaven shop** — flagged for explicit CPA review as an owner-self-dealing transaction.

**Payment infrastructure:** Stripe supports 135+ currencies for charging customers, but **business-side payout availability is concentrated in ~40-plus countries** — sellers/builders outside those face a real limitation, tied directly to the phased international cash-redemption rollout.

---

## 8. Shared Infrastructure with Traverse (Runbot's course-mapping product)

1. **Shared geographic data pipeline:** elevation (USGS), hydrological data, regional biome classification — same underlying real-world data serves both. higglehaven needs only the lower fidelity bar; Traverse's higher-fidelity photogrammetry is additive on the same coordinate system.
2. **3D model/asset reuse:** trees, terrain textures, flora calibrated for a real region in Traverse are directly reusable in higglehaven lánds in the same region.
3. **Speculative long-range integration (not committed):** higglehaven lánds in Traverse-photogrammetry-covered areas could someday use that real photogrammetry as backdrop instead of procedural generation.

---

## 9. Development Roadmap & MVP Sequencing

1. Concept document, LLC/trademark structure, domain registration, waitlist site — no engineering yet.
2. Single-player core, in order: 3D space → product placement → building tools → real estate/plot mechanics.
3. Single-player avatar/movement systems fully proven.
4. *Then*, deliberately deferred past the single-player core: multiplayer presence — seeing other avatars, then speaking to them.
5. Flight can be added at any point.

**Explicit fallback:** if life/Runbot demands intensify, higglehaven development is allowed to lag — the correct safety valve, not treated as failure.

**Vibe-coding workflow:** communicate the full vision conversationally; compress into a precise specification prompt for a coding agent (this document *is* that compression).

---

## 10. Genuinely Open Items

- **[ ] Lándlet hosting cost validation** — the $3–$5/month trigger (§3) needs validation against real measured costs once live.
- **[ ] Currency naming beyond "Dáller"** — deliberately left open, potentially community-crowdsourced.
- **[✓] "God Bless higglehaven" lyric fix — resolved.** "Goth lánd" replaced with **"gamer lánd"** — pairs cleanly with "sports lánd" as the two broad, universally-recognized recurring examples, no subculture-specific connotation. ("Teen lánd" confirmed absent from all recovered source material — never a real concern.)
- **[✓] Builder-chosen ambient music licensing — resolved.** Confirmed direction: a higglehaven-curated royalty-free/pre-cleared music library (YouTube Audio Library / Twitch Soundtrack model), sourced via a licensing aggregator service (e.g. Epidemic Sound, Artlist — confirm marketplace-use terms apply) plus direct artist opt-in at small scale, with Runbot's own music as a natural first entrant.
- **[ ] Runbot's higglehaven account ownership** — leaning Runbot LLC (updated in §6), not yet final; CPA sign-off required either way.
- **[✓] Mixed personal/business purchases — resolved.** Default is genuinely separate personal and business accounts/purchases whenever practically possible. When a single combined purchase is unavoidable, reimbursement between accounts happens **immediately** (not batched monthly), with itemized records (per-line business vs. personal) backing each reimbursement — addresses both the tax-substantiation concern and the LLC liability-commingling risk flagged in v7.

---

*v4 superseded v1–v3. v5 incorporated P122 and P143. v6 incorporated notebook-recovered content (scale, generation timing, avatar/voice numbers, Path B, HOA removal, pioneer correction, first-lándlet choice, land cap uncapped, W-9 timing, LLC lean, ambient music proposal). v7 resolved the credit-card equity concern via the ID-verification alternative path. v8 closed out "gamer lánd," ambient music licensing, credit-vs-debit-vs-prepaid, and mixed-purchase handling. v9 was a full rename from Shoplándia to higglehaven following IP clearance (USPTO, WIPO, WA Secretary of State, domain, and platform checks all clean). v10 enforces the brand's permanent lowercase styling — "higglehaven" is never capitalized, including at sentence start or in headers, matching the wordmark's intentional lowercase "h." No substantive content changed. v11 removes the day-night cycle (§1) — a dark "night" phase read as ominous rather than the intended lighthearted/bright feel, and confirms the visual brand direction (§1): pale green/yellow primary palette with soft supporting colors, clean/minimalist UI using expanding menus. v12 clarifies that reviews require a verified purchase (§5) — standard marketplace practice, closing a gap the original "Review incentives" wording left implicit. v13 adds real account login — email + password (§6) — as the technical account layer the age/ID-verification requirements will eventually gate; that policy requirement itself is unchanged and still not built (needs a real ID-verification/payment-processor integration this dev-stage backend intentionally doesn't have yet). v14 makes "every user is automatically a builder" (§3) literal: signup now provisions a real, linked builder profile automatically, a seller profile provisions lazily on first entering Sell mode, and both Build and Sell mode require a real logged-in account to enter — retiring the free-text dev-mode identity picker §3's builder-status line originally described only conceptually. v15 (current) makes §1's own world-growth trigger ("radius grows ... whenever greenbelt-lánd count falls below 10%") literal too: a scheduled job now grows the world automatically instead of a player-triggered dev-mode stand-in, and every backend endpoint an authenticated user could act on now checks that they actually own whatever they're modifying (previously spoofable via a client-supplied ID) — closing that gap required introducing a real admin role (`users.is_admin`, granted only via a Worker secret, never self-service) to gate the handful of manual world-generation tooling endpoints that have no other identity concept to check against. Remaining open: lándlet hosting cost validation, currency naming beyond Dáller, Runbot LLC account ownership (leaning but not final). Highest prompt number confirmed received via the original Sections document: P143 — notebook-sourced content in v6–v10 was outside that document. Continue versioning up as further material surfaces.*
