# higglehaven design language

Read this before touching any surface. It is the written form of what the
owner asked for in interface week (#3539), and it names every design token in
`src/tokens.css`. One test (`scripts/design-tokens.test.mjs`) keeps this page
and that file in step: a token that is named here must exist, and a token that
exists must be named here.

## What the owner asked for

> There's a lot of clutter, crowding, and clunky looking stuff. We can start
> with an artistic discussion about the look and feel of the app. It should be
> light, airy, and playful. Clean. Sans-serif not just in font, but in
> artistic philosophy. It's hard to maintain highly accessible functionality
> while following this expectation. We need to work hard to find creative ways
> for users to intuitively have quick access to the tools they need when they
> need them, without them cluttering the world when they don't. The 3D world is
> our big selling point. Every overlay of text or modal or traditional user
> interface is a bit of a black stain on this otherwise picturesque world. It
> would be fantastic for the user interfaces to feel like an actual part of the
> world, not a computer screen's popup. I haven't the slightest idea how to
> move in that direction, though. At the very least, nothing should read like,
> "Oh, here's another popup modal, just like every other one I've seen in other
> apps." Though the benefit of familiarity is that users will be able to intuit
> how to access tools. So I suppose there's some balancing that needs to be
> done between those two principles.

(Owner, 2026-11-15. Recorded in AGENTS.md as "The world is the product; every
piece of interface has to earn the space it takes from it".)

## What that means for the work

1. **The world is the picture; interface is a cost.** Every overlay is
   measured by how much of the world it hides and for how long. A change to a
   surface reports that before and after (`node scripts/live-site.mjs
   --cover-report`).
2. **There when needed, gone when not.** A tool appears at the moment and place
   it is useful and leaves by itself. Nothing sits on screen "in case".
3. **Of the world where it can be.** Prefer something that lives in the scene (a
   sign by the thing, a label on the ground, fog that resolves into a card, an
   object you walk up to) over a rectangle laid on the glass.
4. **Familiar enough to find.** Where a platform habit helps a person find a
   tool (close in the upper right, a gear for settings), keep the habit and
   change the dress. Never trade findability for novelty.
5. **Light, airy, playful, clean.** One sans family, generous space, few lines
   and boxes, soft shapes, the pale green and yellow of the brand, motion that
   feels like the world's own (fog, drift), nothing heavy, dark or corporate.
6. **Existing decisions still hold** and mostly point the same way (see
   AGENTS.md): the HUD carries only what moving through and acting on the
   world needs; controls sit where a person looks first; things arrive
   through fog; any text a user can read, they can copy; a destructive action
   is confirmed in its own in-app modal (restyled, never made easy to miss).

## The direction: one flower

The owner was shown three directions as pages to look at (fog and glass, signs in
the world, one bud) and chose the third (2026-11-16, #3540):

> Direction C is real nice. It gives a great combination of aesthetic and
> functionality. We expect users to use gestures with no visible controls, but
> instructions would be quick and easy to find in the bud (at least, that's our
> goal). Let's go full-force into the bud plan. The bud could have the
> higglehaven logo.

Over the following two days the bud grew into a flower (2026-11-18, #3759): the
bud is the flower's head and stays in the upper left for good, petals appear
around it, and an open menu is a stem growing down from it with leaves on both
sides. "Nothing stands on the world but the head" (#3769, #3772, #3770, #3774):
no standing arrows, no compass, no lándlet line on the world; those live in the
open menu. Both are recorded in AGENTS.md ("The interface is one bud", with its
later refinements). The tracking issues are #3648 and #3759. The head does not
move to the lower right; only a mode that cannot show a head in the upper left
sets `body[data-bud-corner]`, and none does today.

The living pictures are `public/design-directions/flower.html` (the flower as it
is now and where it is going: head, petals, stem, leaves, help) and `c.html`
(direction C, the record of the choice). A and B stay beside them as a record and
are not built. The bud's contract (the names and hooks every leaf builds on) is
"The bud" below (`src/ui/bud.js`).

The resting state of the interface is absent. One small, alive, branded thing is
the door to everything else, and findability is paid for by teaching, not by
permanent controls. Everything a person opens has a picture first and one small
word under it ("an icon is a picture of the thing with its word always beside it,
never a mark to be learned"), and a menu is the same wherever it is opened.

### What is live today

Four things are built with:

| thing | what it is for | size and shape | how it arrives and leaves | never |
|---|---|---|---|---|
| **the head** (the bud) | the only standing piece of interface; carries the higglehaven logo; the door to everything else | `--bud-size` (56px), the solid green bud with the logo in cream (`public/bud-head.svg`, option C, #3754), shadow following its outline (`--filter-head`) with a thin pale edge so it holds on grass; upper-left corner, always | breathes slowly (`--motion-breath`); says "Menu" in a small word (`--radius-word`) until first opened, then the word goes; wears one mark for anything unread and, when something is announced, a word that is itself a door (#3774) | carry a count, a second control, or text that stays after it has been learned |
| **a petal** | where a person is: Shop, Build and Sell, in a half-ring at the head; each is a picture (shop front, hammer, price tag) with its word | at least 44px, `--radius-petal`, pale green; the current mode green with `aria-current`; shadow `--shadow-petal` | grows out of the head when it is tapped (0.24s in all, a few tens of ms apart), stays lit while another mode loads, folds back when that mode's first screen is up | be a thing you open (those are leaves), or sit apart from the head |
| **a leaf** | a thing you open from the head's menu: You, Notices, Friends, Purchases, Settings, Help; in Build, Add item, Lándlets, Levels, Undo, Tools; in Sell, My products, Add product | an icon with its one word under it, 76px wide, `--radius-leaf`, `--shadow-leaf`; leaves alternate right and left of a stem set 88px in from the edge | the stem grows from the head and the leaves open in turn (about a third of a second in all); the same way back | open on top of another leaf, or leave a leaf without an icon in `src/ui/budIcons.js` |
| **a card that blooms beside a thing** | a product's name, price and Buy, or the item selected in Build with its actions; where the thing is | `--radius-bloom`, a short stem down to the thing, one yellow petal (`--petal-yellow`) for Buy | scales up out of the thing over `--motion-bloom`; goes when the person walks on | hide the thing it is about |

A leaf that opens a sheet (Settings, a friend list, a chat) is a **sheet** that
grows from the head's corner: `--radius-leaf`, `--shadow-leaf`, panel yellow over
a soft white wash, no dimming scrim, close in its upper right, one at a time, no
wider than the screen, scrolling inside itself.

Everything else is a gesture on the world itself: drag on the left half of the
screen to walk, drag on the right half to look, double-tap to fly (flight is level, so you can look
straight down; slide a thumb up or down along the right edge to rise or sink), tap a product to open
its card. A gesture cannot be seen until it is taught once, so the head teaches (it
pulses and says Menu until first opened) and the instructions live in it, one tap
away, under Help. Under `prefers-reduced-motion` nothing animates.

### Still to come

Not built yet; do not describe these to a person as if they exist:

- **One help door** (#3762): a "Help" leaf (a question mark) holding how to move, how higglehaven
  works, the manuals for shopping, building and selling, and the way to an
  assistant.
- **The head's look** (#3754): the owner chose option C on 2026-11-20, the solid
  green bud with the logo in cream. It is the head in the app (`public/bud-head.svg`),
  and `flower.html` keeps only that drawing; the pale circle with the square logo tile
  is retired. Known cost: cream on `#6ca42e` is about 2.7 to 1, a little under the 3 to 1
  that a graphic wants, and the logo is large and the word "Menu" sits beside it; the
  unread dot sits on the bud's shoulder, ringed in white.
- **Wordmarks** (#3771, #3780 to #3784): a lándlet's name at the top of the open
  menu in lettering the builder chooses from a set. One renderer (`src/ui/wordmark.js`,
  #3782) draws it: the name stays selectable text with the style and colours as data
  attributes and variables, a face is fetched once and only when a name asks for it, and an
  id that `shared/wordmark-set.js` does not offer draws the default look. The owner's pick
  from the lettering page is one line in that set.
  Builders choose in My lándlets, Wordmark (beside Rename; `src/ui/wordmarkPicker.js`, #3783), which is
  drawn only once the set offers more than the default. The name wears the choice in the open menu (Shop
  and Build) and in the My lándlets list (#3784); the assistant handbook gets its Wordmark steps when the
  owner's pick makes the button appear, since the handbook is tested against the real controls.
- **Loading tips that last** (#3763): paced for a slow reader, switchable off in
  Settings, kept under Help.

"Full-force" means no half-way: when a surface moves into the flower, the old
control for it goes in the same change ("One model, not a hybrid" in AGENTS.md).
A session that finds something that cannot be done by gesture, or cannot fit a
leaf, says so on #3759; it does not quietly keep the old control.

## How to use the tokens

Every value below is a CSS custom property in `src/tokens.css`, loaded before
`src/app.css` by `index.html`. Write `var(--token)`, never the literal. If a
value you need is not here, add a token (and name it on this page) instead of
a literal, so a later restyling is one edit.

The admin pages (`public/admin-*.css`) keep their plain utility look and are
not on this system.

The first pass of tokens carried the values the stylesheet already used, so
adopting them changed nothing on screen (checked by substituting every token
back and comparing with the old file). The owner then chose the bud, which became
the flower (the section above); its tokens are in `src/tokens.css` under "The
bud". The near-duplicates listed under "Where the clutter is" were collapsed in
#3656; what is left there is a short list of literals, not a pass of its own.

## Colour

The palette is two pale surfaces and one ink, with one saturated green for the
active state and one coral for danger.

| token | value | use |
|---|---|---|
| `--ink-rgb` | `22 36 10` | the one dark-green ink, as channels so a use can pick its own opacity: `rgb(var(--ink-rgb) / 0.25)` |
| `--white-rgb` | `255 255 255` | white as channels, for the bud and its leaves' sheen and rings: `rgb(var(--white-rgb) / 0.9)` |
| `--black-rgb` | `0 0 0` | black as channels, for a quiet fill or a mask: `rgb(var(--black-rgb) / 0.1)` |
| `--ink` | the ink as a colour | text and lines on either pale surface |
| `--pill-rgb` | `214 232 190` | the small floating HUD chrome: pale green |
| `--panel-rgb` | `250 240 199` | large, text-heavy dialogs: pale yellow |
| `--pill-text` | the ink | text on a pale surface |
| `--pill-text-soft` | the ink at 65% | secondary text on a pale surface |
| `--brand-green` | `#6ca42e` | the active state only; a step up in intensity from the pale surfaces |
| `--brand-green-rgb` | `108 164 46` | `--brand-green` as channels, for its tints on an expanded row or a brush |
| `--spring-green-rgb` | `62 199 91` | the movement controls' resting state, brighter than the brand green |
| `--danger` | `#e2694f` | the one accent for destructive actions: a friendly coral, not a dark red |
| `--danger-rgb` | `226 105 79` | `--danger` as channels, for a destructive form's outline |
| `--denied-rgb` | `255 92 92` | a muted or refused voice control |
| `--danger-line-rgb` | `255 120 100` | the outline of a destructive row action |
| `--danger-soft-rgb` | `255 180 168` | coral text on the dark delete control |
| `--danger-text` | `#a83a27` | coral for text; at least 4.5:1 on panel, pill and tinted rows |
| `--danger-strong` | `#c0392b` | filled destructive controls |
| `--danger-bright` | `#d9483a` | alert dots and badges |
| `--danger-on-dark` | `#ff8a80` | coral text on the dark in-world labels |
| `--leaf-text` | `#3f7a1f` | success and "ready" text on a pale surface |
| `--leaf-deep` | `#4e7622` | filled success controls |
| `--sky` | `#4a9bd1` | information, selection of another person's things |
| `--sun` | `#ffd93d` | the one warm highlight (stars, rewards) |
| `--petal-yellow` | `#f6d65c` | the one yellow petal: Buy on a product's card, and the open surface's own petal |
| `--white` | `#fff` | text on a saturated fill and thin rings |
| `--world-fallback` | `#eef4e0` | the page colour behind the canvas before the scene draws |
| `--scrim-soft` | black at 22% | a quiet fill behind a preview or well |
| `--scrim` | black at 35% | a dimmer behind a dialog |

Contrast, measured on the actual values (WCAG ratio; 4.5 is the floor for
text, 3 for large text and controls):

| text on surface | ratio |
|---|---|
| ink on pill | 12.5 |
| ink on panel | 14.2 |
| ink on brand green | 5.4 |
| ink on spring green | 7.4 |
| ink at 65% on panel | 4.9 |
| ink at 65% on pill | 4.6 |
| danger text on panel | 5.6 |
| danger text on pill | 4.9 |
| leaf text on panel | 4.6 |
| leaf text on pill | 4.0 (use ink for body text on pill) |
| white on brand green | 3.0 (large text or an icon only) |
| ink at 50% on panel | 3.1 (decoration and disabled only, never information) |

A surface that sits over the 3D world cannot know what is behind it, so text
never relies on the world for contrast: it sits on a pale surface at 0.85 or
more opacity, or it is the ink with `--shadow-text-over-world` on a label that
has no surface.

## Type

One sans family: the platform's own sans-serif, as the app has always used and
as direction C's pages do. A specific face may be named in `--font-sans` later
and nothing else changes.

| token | value | use |
|---|---|---|
| `--font-sans` | `sans-serif` | everything a person reads |
| `--font-mono` | `monospace` | codes and ids only (a copied reference, a key) |
| `--text-2xs` | 11px | captions, badges, fine print |
| `--text-xs` | 12px | secondary lines and labels |
| `--text-sm` | 13px | the default for HUD pills and controls |
| `--text-md` | 14px | the default for dialog body text |
| `--text-lg` | 16px | emphasis inside a dialog |
| `--text-xl` | 18px | dialog and card titles |
| `--text-2xl` | 20px | a headline (the title screen) |
| `--leading-none` | 1 | single-line controls |
| `--leading-tight` | 1.3 | titles |
| `--leading-normal` | 1.4 | body text |
| `--leading-loose` | 1.5 | long reading |
| `--weight-regular` | 400 | body |
| `--weight-semibold` | 600 | titles, buttons, the active tab |

No font size in `src/app.css` is a pixel number: all are tokens. (In the #3656
pass the 17px size became 16px, the stray 10px and 15px sizes moved onto 11px
and 16px, and 18px and 20px took the names `--text-xl` and `--text-2xl`.)

## Space

Padding, margins and gaps are built from these steps.

| token | value |
|---|---|
| `--space-3xs` | 2px |
| `--space-2xs` | 4px |
| `--space-xs` | 6px |
| `--space-sm` | 8px |
| `--space-md` | 10px |
| `--space-lg` | 12px |
| `--space-2xl` | 16px |

Generous is the aim: a dialog's inner padding is `--space-2xl` or more, and a
gap between two controls is never smaller than `--space-xs`. Touch targets are
at least 44 by 44px for anything a thumb must hit while moving; the smallest
control that may sit in a settings list is 32px tall.

## Shape

| token | value | use |
|---|---|---|
| `--radius-sm` | 4px | small inputs, badges and swatches |
| `--radius-md` | 8px | buttons, fields, rows and cards inside a dialog |
| `--radius-lg` | 12px | dialogs, media and previews |
| `--radius-pill` | 999px | the HUD pills and any control meant to feel soft |
| `--radius-round` | 50% | round buttons (fly, joystick, close) |
| `--radius-petal` | 24px 5px 24px 5px | a petal of the bud |
| `--radius-bloom` | 28px 6px 28px 6px | the card that blooms beside a product |
| `--radius-leaf` | 30px 6px 30px 6px | a leaf that grows from the bud |
| `--radius-petal-flip` | 6px 24px 6px 24px | a petal's mirror image, for the side the menu opens toward |
| `--radius-leaf-flip` | 6px 30px 6px 30px | a leaf's mirror image |
| `--radius-word` | 12px 3px 12px 3px | the small word beside the bud |
| `--bud-size` | 56px | the bud's width and height (not a radius; kept here with the shapes) |

Soft shapes: a pill or a circle before a rectangle with corners.

## How a surface sits over the world

| token | value | use |
|---|---|---|
| `--shadow-card` | 0 6px 18px, ink at 18% | a card that must lift off the scene |
| `--shadow-text-over-world` | 0 1px 2px, black at 90% | a text label with no surface, so it reads on any scene |
| `--shadow-bud` | 0 2px 10px, ink at 22% | the bud |
| `--shadow-petal` | 0 4px 14px, ink at 20% | a petal |
| `--shadow-leaf` | 0 8px 26px, ink at 20% | a leaf and a card that blooms |
| `--shadow-breath` | 0 6px 18px ink at 18%, and a 5px white ring at 35% | the bud's breath at its fullest |
| `--filter-head` | a thin pale edge and a drop shadow 0 4px 8px, ink at 25% | the head's shadow, following the bud's outline (#3754) |
| `--filter-head-breath` | `--filter-head` with the shadow deeper and a soft white glow | the head's breath at its fullest |
| `--filter-head-pulse` | `--filter-head` with a spring-green glow | the head's pulse until it is first opened, and while an assistant window opens |
| `--filter-petals` | drop shadow 0 4px 8px, ink at 20% | one shadow for the ring's three petals together (a filter, so a clip-path cannot cut it off) |
| `--glow-teach` | 4px spring-green ring at 35% | the "?" icon while the bud teaches |
| `--glow-pulse` | 8px spring-green ring at 35% | the bud's pulse until it is first opened |
| `--ring-badge` | 2px white ring at 90% | the dot on a leaf that holds something waiting |
| `--ring-focus` | 3px spring-green ring at 60% | a focus ring |

The opacities a surface may use are a short list, not free choice:

| token | value | use |
|---|---|---|
| `--fill-row` | ink at 8% | a list row's fill, one step quieter than `--alpha-faint` |
| `--alpha-faint` | 0.12 | a quiet fill or a track |
| `--alpha-line` | 0.25 | a hairline border |
| `--alpha-half` | 0.5 | a tinted well; disabled |
| `--alpha-soft` | 0.65 | secondary text, a resting pill |
| `--alpha-strong` | 0.9 | a surface that text sits on |

Today HUD chrome is a pale-green pill at 0.65 to 0.95 opacity, and dialogs are
a pale-yellow panel at 0.97. No surface blurs what is behind it. Borders are
one pixel at ink 25% where they exist at all.

## Inside a leaf

A leaf is a sheet; what is inside it is made from five parts, and only these
(#3933). Each is written in tokens, so a change to a token moves every leaf. The
numbers are the "before" the inventory on #3933 counted from `index.html` and
`src/app.css`: 18 list-row classes in 6 paddings, 64 button classes in about 30
looks, 22 field rules in 12 looks. The target is one of each.

| part | what it is | made of |
|---|---|---|
| **a row** | one thing in a list: a friend, a notice, an order, a sign post, a product | an optional picture or icon at the start; the name in `--weight-semibold`; at most one secondary line in `--text-xs` at `--alpha-soft` (a time, an author or a status goes here, not in a class of its own); at most one trailing action, a quiet button. Fill `--fill-row` (ink at 8%), `--radius-md`, padding `--space-md` by `--space-lg`, `--space-sm` between its parts, `--text-sm` |
| **a field** | one thing to type or choose | the label above in `--text-sm`; a helper line under it in `--text-xs`; the control with ink at `--alpha-faint` as its fill, a 1px border at `--alpha-line`, `--radius-md`, padding `--space-sm` by `--space-md`, text `--text-lg` (16px, so a phone does not zoom on focus). A required field starts empty and its helper line says what to enter; its error appears on the step that holds it, in `--danger-text` |
| **a primary button** | the one thing a leaf is for ("Save", "Send", "Buy") | `--brand-green` fill, `--ink` text, `--radius-pill`, padding `--space-sm` by `--space-2xl`, at least 44px tall; one per leaf, at the bottom or beside the field it acts on |
| **a quiet button** | every other action | no fill, a 1px border at `--alpha-line`, `--ink` text, `--radius-pill`, padding `--space-xs` by `--space-lg`, at least 44px to hit; a destructive one reads in `--danger-text` and is confirmed in its own modal |
| **a heading and a line** | the leaf's name and what it says about itself | the leaf's title once, `--text-xl` in `--weight-semibold`, close in the upper right; a section heading `--text-md` in `--weight-semibold`, no rule under it; a status or empty line `--text-sm` at `--alpha-soft` (`.empty-state`); a refusal or error in `--danger-text`, selectable and kept until dismissed; a success may fade |

Rules that already apply and are not repeated per part: the control that closes
is in the upper right; the actions on a thing sit under its name; any text can
be selected and there is no Copy button; an icon is a picture of the thing with
its word beside it; a leaf does not change what it does when it changes how it
looks. A row, field or button that is not one of these five is either an
exception named on #3933 or the next thing to bring onto them.
`npm test` holds the count of distinct row looks at one (`scripts/leaf-parts-baseline.json`,
#3939): a new `-row` class joins the shared row rule in `src/app.css` and keeps only its layout.
In Sell > My products a product's detail lines (size, price, digital good, returns, shipping) are
`--text-sm` in full ink, and the Edit/More/Reviews/Sales links are 44px tall tap targets in full ink
(`--pill-text-soft` on the expanded row's green measures about 4.3, under the 4.5 floor);
`scripts/check-seller-row-readable.mjs` holds it (#3589).

## Motion

| token | value | use |
|---|---|---|
| `--motion-quick` | 100ms | a press or a hover on a control |
| `--motion-fade` | 0.4s | a surface or notice coming or going |
| `--ease-soft` | ease | the default curve |
| `--motion-breath` | 3.4s | one breath of the bud |
| `--motion-bloom` | 0.45s | a leaf or a card blooming |
| `--motion-petal` | 0.42s | a petal unfolding (40ms apart) |
| `--motion-fog-away` | 6s | a hint thinning away like fog |
| `--ease-bloom` | cubic-bezier(0.2, 0.9, 0.3, 1.2) | the bloom curve: a soft overshoot, never a bounce off screen |
| `--motion-grow` | 0.3s | a part of the flower growing out of its parent: a petal from the head, the stem's leaves, a leaf sheet, the note beside the head (a petal takes `--ease-soft`, not `--ease-bloom`: it travels out from the head and must stay joined to it) |
| `--motion-fold` | 0.2s | a part folding back into its parent: the petals into the head, the note |
| `--ease-fold` | ease-in | the curve for folding back: it gathers speed as it goes |
| `--motion-reduced` | 0.15s | the plain fade that replaces growing and folding under `prefers-reduced-motion` (nothing grows, nothing drifts) |
| `--motion-open-petals` | 0.2s | the petals and the top row forming out of the head (0 to 0.2 s; the petals 0.03 s apart) |
| `--motion-open-stem` / `--delay-open-stem` | 0.25s / 0.1s | the stem drawing down from the head (0.1 to 0.35 s), overlapping the petals |
| `--motion-open-leaf` / `--delay-open-leaves` / `--step-open-leaf` | 0.2s / 0.22s / 0.02s | the leaves unfurling from the stem, top to bottom, each 0.02 s after the one above (done by 0.5 s) |
| `--motion-fold-leaf` | 0.12s | on folding, a leaf going into the stem, then the stem drawing up into the head (each 0.12 s), then the petals and the row (`--motion-fold`); about 0.5 s in all |

The world's own motion (fog that resolves into a thing, drift) lives in the
scene code, not in CSS; see "Things arrive in the world through fog" in AGENTS.md.
Nothing bounces, snaps or slides in from off screen.

## Voice

The words are part of the look: light, airy, plain and warm. Sixteen sessions wrote them over three
months, so they disagree with each other in small ways. This page says what we do. It was written
from reading every string a person can see (`node scripts/list-copy.mjs`, about two thousand lines,
by area, with a tally), and the part a machine can check is checked on every test run
(`scripts/check-copy-voice.mjs`). The standing decisions behind it are in AGENTS.md: "The word is
lándlet, always", "Public-facing copy describes what the user sees, never internals", "A message that
limits or refuses an action states the limit and when it lifts", "Any text a user can read, they can
copy", and text that helps nobody act goes. Where this page and today's strings disagree, the page is
the target and each area's pull request brings its strings in line, listing them before and after.

**How it sounds.** Plain, short, kind. Talk to "you", in the present tense, with contractions
("couldn't", "you're", "it's"). One idea to a sentence. Say what is, then what to do. No jargon, no
"please" as filler, no exclamation marks except to celebrate something the person did (winning an
auction), no blame ("invalid", "you must", "error").

**What we call things.**
- A plot of ground is a **lándlet**, with the accent, every time, in the app, in emails, in what
  assistants say. Never "land", "lánd", "landlet" or "plot". (Checked.)
- **higgles** is lowercase, plural, and starts a sentence only when it has to.
- A **product** is something for sale. An **item** is a product placed on a lándlet in Build. Do not use
  one for the other.
- The **menu** opens from the logo bud at the top left. A person never reads "bud", "flower",
  "petal", "leaf", "stem" or "modal": those are our words for how it is built. Name a thing by what it
  opens ("Notices", "Orders") and a window by what is in it. (Checked.)
- A **username** is a person; a **shop name** is a shop. "Profile" only where a reset or a delete needs
  to say what it resets.

**Capital letters.** Sentence case for every control, title and label: "Add a product", "My
purchases", "Log in", "Submit feedback". A capital starts the sentence and names a proper thing: Shop,
Build and Sell (the three places), a person's name, and higglehaven, which is lowercase even at the
start of a sentence in the logo and capitalised like any word otherwise. A short label (up to six words, no sentence stop) with a capital in the middle that is not one of
these fails the test run (`scripts/check-copy-voice.mjs`, `CAPITAL_OK` and `ALLOWED_LABELS` list the
exceptions and why); a sentence is read, not checked.

**How we say no.** Name what can't be done, then what to do or when it lifts, in one or two
sentences. A limit that has a number gives it from the server: "You can collect up to 20 orbs every 15
minutes. Try again in about 7 minutes." Use "can't" for a limit and "couldn't" for something that
failed ("Couldn't rename this. Try again."). Today "could not" outnumbers "couldn't" about five to one;
"couldn't" is what a person would say, so it is the target. Never a bare developer sentence ("name
must be a string") in front of a person.

**How we say it was our fault.** Say so, briefly, and say it will likely work again:
"higglehaven ran into a problem on its end. Try again in a moment." Do not apologise at length and do
not show a code. "Please" is not needed.

**What we never say.** An issue number, a file name, a route, a column, "seller identity" or any other
word from inside; "invalid" or "error" as the whole message; "click" where a person may be touching
(say "tap", or "tap or click" where both are true); "Are you sure?" without naming the thing.

**A control's word and its name agree.** What a person sees on a control is what a screen reader
says. A hidden name that differs from the visible word ("Menu" shown, "Account menu" announced) is
allowed only where the visible word is a picture's label and the announced name is longer, never the
other way round.

**Not yet checked by a machine, so read for it:** case inside a sentence, "couldn't" against "could not", the length of a
sentence, and whether it says what to do next. Add a check here when one can be written without
false alarms.

## Things said out of turn

Something the app says to a person that they did not just ask for (it worked, it was refused, it
failed) is said in one of three places, never as a toast floating over the world and never in a
browser dialog (#3889; the table of what existed is in the first comment on that issue).

- **(a) At the thing it is about.** A card says it about its own product; the Build selection status
  sits under the item it is about; a reversal plays where the thing was (the orb's grey puff).
  Built: a purchase is confirmed on the product card it came from ("Yours now.", with a burst of
  confetti at the product, #3945). Not built: the one-time delivery link (see "Stays a notice" below).
- **(b) In the leaf or the modal, by the control that was used.** `showInlineActionStatus`
  (`src/ui/inlineActionStatus.js`) or the sheet's own status line. A confirmation of something done in
  a leaf ("Report sent") belongs here, not over the world.
- **(c) A word beside the head that opens to the full sentence.** `sayAtHead` / `clearSaying`
  (`src/ui/headSaying.js`) over `setBudWord` and `openLeaf`. For something true of the whole app that
  has no control or thing to say it at: "Graphics paused", "Offline", "Orb limit".

Rules for all three. A **success** may fade by itself (a plain word, no door). A **refusal or failure**
stays until its sentence has been read: `readOnce` clears the word when its leaf is closed, and the
text is ordinary selectable text, with no Copy button (AGENTS.md, "Any text a user can read, they can
copy"). A message that limits something says the limit and when it lifts, with the numbers from the
server's reply, never a copy of them in the client. Two words at once do not stack on the world: the
latest is worn, and the earlier one shows again when it is read. Remove the old message in the same
change that moves it ("One model, not a hybrid").

**Stays a notice modal** (`showNotice`, `src/ui/noticeModal.js`). The rule of thumb: a message stays a
modal only when nothing on the screen could carry it *and* it has to be read before the person goes
on. That means one of three things: it is not the result of a tap on a control (a sign-in, an emailed
link), it says work may be lost so it has to wait to be closed ("No silent loss"; a line that the next
action overwrites is how a loss goes unnoticed), or it is shown once and the person must be able to
select it. Anything else is (a), (b) or (c), and a new message never copies the modal. The callers
that stay, checked against the code on 2026-11-20 (#3889):

- **Account suspension** (`src/account/auth.js`): shown once on sign-in, not tied to a tap, no
  control to sit beside; it can be read again from the Account menu.
- **"Delivery confirmed" and "Couldn't confirm delivery"** (`src/main.js`): opened from an emailed
  link by someone who may have no account and no panel, who cannot look the result up afterwards.
- **"Note already removed"** (`src/main.js`): the result of a tap on a sign in the world; there is no
  panel row to carry it.
- **"Blocked"** (`src/blocks.js`, how to unblock): follows a block made from the friends list or a
  message, and what it says leaves the panel it was made in.
- **The delivery link after a purchase** (`src/shop/productCheckout.js`, "Purchase complete"): shown
  only once, so it is a sheet the buyer can select from (#3249); the confirmation itself is on the
  card.
- **Build's save and placement failures** (`tellBuilder` in `src/build/scene.js`, fifteen uses):
  they arrive after the gesture, from a background save, often for several items at once, and say
  work may not survive a reload or was taken off the builder's lándlet.

Not yet moved, and not decided to stay: the purchase refusal ("Purchase didn't go through",
`src/shop/productCheckout.js`). It involves money, so moving it is its own careful change. Also
`tellBuilder`'s few results of a tap (placed or restored counts) could be a line on the toolbar; they
are rare and name a count, not a control. Equipping an avatar or animation, nearby-chat and voice
reports, Build's metadata modals and the shared picker have already moved onto (a) and (b).
## Never

- A heavy or dark panel, a black or near-black surface, a thick border.
- A box inside a box inside a box. One surface, then content.
- More than one typeface, or text smaller than `--text-2xs`.
- A literal colour, size, radius or space in `src/app.css` where a token exists.
- A control that is only an icon with no name for a person using a screen reader.
- A confirmation that can be missed (see AGENTS.md), however light the dress.
- A new popup for something that could be said in the world.

## The bud

The contract below is for the flower's head, still called the bud in code (`src/ui/bud.js`,
`--bud-size`, `body[data-bud]`): internal names keep the plain word. In every
mode the only standing interface is the head, one small, slowly glowing bud in the
upper left, carrying the higglehaven logo; until it has been opened once it pulses
and says Menu. Tapping it opens the menu: a stem with leaves, and the ring of mode
petals; a leaf runs an action or opens a sheet (a soft sheet by the head, close
control upper right, one at a time). Everything else is done
by touching the world. The module is `src/ui/bud.js`:

- **Three menus and one row (#4025, part of #3759; replaces #3760's four menus).** One tap on the head
  opens everything together: the three petals (Shop, Build, Sell), the stem and leaves of the place the
  person is in, and a row of icons along the top for what belongs to no place: the account, Notices,
  Settings and Help (an Assistant leaf joins the row while a conversation is minimised). There is no Menu
  petal. Each place has its own menu and it never changes with circumstance: Shop's (Friends, My purchases,
  Chat, Nearby: the products within reach, nearest first, each a row that opens its card, for a screen
  reader on a phone, #3824), Build's (Add item, My Lándlets, Levels, Undo and Redo, Tools, and the
  lándlet cap line) and Sell's (My products, Add a product, Payouts, Storefront, Orders). The row is the
  same in every place and is part of the flower: it grows with the petals and folds with them (the
  leaves fold into the stem, the stem draws up, then the petals and the row close). **The row draws no
  words (#4199, owner 2026-11-24):** its four icons (person, bell, gear, question mark) are known
  everywhere, so each is a round 44px chip (pill-green wash, `--shadow-petal`) with the icon alone. This is
  the one place the "icon with its word" rule is relaxed: petals and leaves keep their words. The word is
  still in each button for a screen reader and is its `title`, so a mouse hover or a long-press says it.
  A tap on a place you
  are not in takes you there (the page reloads and the ring stays out); a tap on the place you are in
  only marks where you are, since its menu is already open; the head, Escape or the world folds all of
  it. At 390 px the row sits to the right of the head, above the lándlet's name card and the compass,
  and the three do not cover each other. Every leaf in the stem carries the menu it belongs to
  (`data-bud-menu`) and is drawn only while that menu is open (`body[data-bud-menu]`, which is always the
  current place's); the row's buttons are in `#bud-row`. The rules are in `src/ui/budMenuRules.js`: the
  row's members are a fixed list, and registering a place's tool into it is refused (an error in
  development and in tests, logged and skipped in the shipped app), so adding a member to the row is a
  deliberate edit of that list and of this paragraph, never an accident. The ring's three petals sit
  30 degrees apart (6, 36 and 66 degrees); the stem starts below them.
- `registerBudPetals(mode, [{ id, label, run }])`: one definition per menu
  (`shop`, `build`, `sell`, and `row` for the top row's own members). A mode with none has no bud, and keeps its old
  controls until its own leaf. `body[data-mode]` says which mode is showing and
  `body[data-bud]` is `on` when that mode has the bud.
- `addBudPetals(mode, [petal])` (#3690): adds petals to a mode without
  replacing the others, so each slice of a mode lands its own (a petal with the
  same `id` replaces the earlier one). A petal with `element` adopts that
  element instead of making a button: Build's Undo and Redo are one petal, a
  pair holding the existing `#undo-btn` and `#redo-btn` with their handlers
  untouched. `visible()` says when it is drawn (the pair only once there is
  something to undo or redo) and `refreshBud()` re-reads it.
- `openLeaf({ id, title, render, onClose })` and `closeLeaf()`: one leaf at a
  time; `render(bodyEl)` fills it. Escape or the close control closes it.
  `onClose` runs as it goes, while the leaf still exists: a leaf may borrow
  existing elements (Levels borrows the level label and the Up/Down/Build/Dig
  panel, parked in `#level-controls`) and hands them back there, so the
  handlers on them never have to be rewritten.
- Tools (#3691) is the same pattern for Multi-Select (with its Brush slider), Measure and
  Paste, parked in `#tool-controls`. Choosing Multi-Select, Measure or Paste puts the
  leaf away so the world is clear; while Multi-Select or Measure is on the bud wears
  "Selecting" or "Measuring" (`setBudWord`, following the buttons' `aria-pressed`).
  Paste is listed only after a Copy. The Brush slider blooms beside the selection: while
  Selecting is on and the item card shows the painted selection, `src/build/itemCard.js`
  moves `#multiselect-brush-control` into the card (`#item-card-brush`) and back out when
  the card closes or Selecting ends; the card passes taps through while painting, but the
  slider takes them. With nothing selected yet it is still in the Tools leaf.
- Bundles (#3692): Bundle, Unbundle, Edit and Save Bundle are buttons of the item card (the card that
  blooms beside the selection), with the same ids and handlers; Edit's reason line shows under them.
  While Multi-Select paints, the card keeps the bundle actions (Copy, Delete and More wait for
  Multi-Select to end) so it covers as little of the world as it can.
- More (#3693): Community Sign, Community Calendar and Backup Chain are buttons in the item card's
  More beside Snap, ids and handlers unchanged; they are rare and about one item. The claim map is
  still one large leaf of its own.
- `setBudWord(key, text, { open, label })` and `clearBudWord(key)` (#3774): the word the bud
  wears beside it. A word that announces something carries its door: with `open`, the word is
  a real button (`#bud-note`, at least 44px tall, a pressed state, `label` for a screen
  reader) that grows out of the head and folds back, and a tap folds the bud and runs `open`;
  the key's owner clears the word once the thing is open (an assistant's reply opens the
  conversation at the newest message). With no `open` it is only a word, as before.
- `setBudMark(key)` and `clearBudMark(key)`: any key set shows the bud's one
  unread mark; it clears when none are left.
- The bud is the existing account toggle and its petals are the buttons of the
  account panel, so a row there is already a petal. Do not rebuild a panel to
  make a petal; move it, and remove the old control in the same change.
- Settings is a leaf in the same way (#3652): a soft sheet at the bud's corner with no
  dimming scrim, so the world shows around it; it stays inside the screen and scrolls
  inside itself. A panel that moves into the bud takes this look, not a full-screen
  dialog.
- The Build tab of Settings keeps its first screen for what a builder does often (#4019, which
  reverses the part of #3652 that put the username, lándlet cap and low stock there): Publish and
  the newest version are on top. Everything else is a closed `<details>` row below, using the
  same `.settings-account-fold` look: "Earlier versions" (inside Version history, drawn only once
  there is an earlier one), "Higgles and auctions", and "Profile, lándlet cap and stock"
  (username with Rename and Reset profile, lándlet cap, low stock, sold-out markers). A row
  starts closed each time Settings opens and stays as the person left it while that Settings is
  open (a rename redraws the tab). The Build tab had been 86% of a phone screen; the measured
  figure after this change is owed from a look at 390x844.
- The three modes are a petal group of their own, a half-ring at the bud's corner (#3723,
  #3752): Shop, Build and Sell are `.mode-nav-btn` buttons in `#bud-modes`, the same three in
  every mode with the current one green and `aria-current`. Each is a petal: a button turned to
  point away from the bud's centre (at 8, 46 and 84 degrees, 38 apart so their 44px
  bodies never touch), clipped to a point at the bud widening to a soft tip, with its base
  tucked under the bud (the bud paints above the ring) so it reads as attached, placed from
  `--bud-size` so a bud of another shape needs only the same centre and size; its label is
  turned back upright. The column of things you open starts 92px lower, under them, and keeps
  its own rounded shape: where you are and what you open look different. The arc opens away from
  the screen edge (`body[data-bud-corner="bottom-right"]` flips it). A mode is never a petal of
  the column, and the ring is last in reading order.
- The ring moves like the bud is alive (#3752). Tapping the bud grows the three petals out of
  its centre (turned out from the base and scaled up, a few tens of milliseconds apart, 0.24s
  in all); closing reverses it. A tapped mode answers at once: its petal turns green with the
  ring still out (`body[data-bud-ring="held"]`, no motion) while the mode loads across the
  reload, and when the mode's first screen is up (`higglehaven:mode-ready`, from the opening
  screen lifting) the petals fold back in (`"folding"`). If the mode will not load
  (`higglehaven:mode-failed`) the ring stays out with the mode you are still in marked, and the
  opening screen shows the reason. Tapping the mode you are already in only folds the bud.
  `prefers-reduced-motion` gets a plain fade. The word beside the bud and the Sell pager step
  aside while the petals are out. The record that carries "a switch is in progress" across the
  reload is `sessionStorage["higglehaven.budSwitch"]`, good for 60 seconds.
- An open menu is a stem with leaves on both sides (#3761, the flower). The stem is set 88px in
  from the screen edge, because the head is in the upper left and the left-hand leaves need
  room; leaves are 76px wide, the first on the right and then alternating, their pitch about
  half a leaf's height so a left leaf sits between two right ones. Each leaf is an icon with
  its one small word under it: the picture is the main thing and the word is always there,
  never a tooltip. Icons are inline SVG in src/ui/budIcons.js, one line weight, drawn in the ink
  colour; a leaf with no icon there gets a plain leaf and a console warning, so a new leaf cannot
  ship as words only. src/ui/bud.js places the stem by walking the *visible* leaves (never
  :nth-child) and again whenever one is added, shown, hidden or has its text replaced. **(#4200)** Each leaf
  joins the stem at its tip, not along its side: a right leaf's pointed upper-left corner is on the stem and it
  opens down and away to the right, a left leaf is the mirror image, with a small knob where the tip meets the
  stem; the icon and word stay upright. The head is turned to point down and to the right, toward the petals,
  so its base is at its upper left, where the stem enters it and runs down the left behind it (the logo inside
  stays upright; public/bud-head.svg rotates only the bud). The stem
  grows from the head and the leaves open in turn (about a third of a second in all); under
  reduced motion they simply appear. The lines that are not leaves (the lándlet cap) sit below
  the last leaf.
- **The stem is a plant's stem (#4026).** Green (`--brand-green`, the head's own green), 6px with a 2px pale
  edge on each side (10px in all) and a hairline of ink outside that, one continuous curve with no corner:
  it leaves the head on the head's own centre line, runs down, curves across to the leaves' line above the
  first leaf and goes straight down to the middle of the last leaf (`#bud-stem`, an svg that
  src/ui/bud.js draws from the measured boxes). It is drawn down from the head as the menu opens and drawn
  back up into it as it folds. The leaves' connectors take the same green and weight. Contrast of the whole
  stem against the ground behind it (WCAG ratio, `--panel-rgb` edge over each ground): grass 3.4, near-water
  3.2, upland 2.6, alpine 2.5, sky 1.5 for the edge alone, and the ink hairline lifts the pale grounds
  further; the green core on its own against the pale edge is 2.5. This is the trade the owner made on
  2026-11-21 (a stem that reads as green and not black, over the near-black of #4024); it is below the 3:1 of
  #3818 on upland, alpine and sky, which the pale edge and the hairline carry.
- The three mode petals of the ring (#3761) are a picture first with their one small word under it, like every
  leaf: a shop front, a hammer and a price tag, drawn in the same line weight (src/ui/budIcons.js, by the
  petal's `data-mode`). The picture sits in the petal's upright label, so it stays upright with the word
  however the petal is turned.
- The compass is not on the world (#3772). It sits in the open menu's head row, right of the lándlet's
  sign (or alone in Sell, which has no sign), in every mode, and is not drawn while the menu is shut.
  Every leaf (Settings, My products, Friends and the rest) runs to the same margin on the right as on
  the left, because nothing stands in the upper right to leave room for.
- The lándlet a person is on is named at the top of the open menu (#3770), before any leaf: a small
  sign in the same leaf shape in the head's row, to the right of the ring of modes. The name is a
  wordmark (a flourished serif in the ink green, the family of the higglehaven wordmark) with "by
  <builder>" small under it. Shop keeps it current as the avatar crosses lándlets, Build names the
  lándlet being built, and Sell names nothing, because the showroom is not a real place. It is
  selectable text and a tap does nothing. The name and the builder are separate spans
  (src/ui/budPlace.js), and the lettering lives on one class, so the wordmark renderer (#3782)
  swaps the face and colours without touching the layout. The three lines of grey text that used
  to sit between Settings and How to move are gone.
- The glow, never a scale, is the bud's breath: a control that moves is hard to
  tap, and cannot be clicked by a test.

## Where the clutter is

`node scripts/design-census.mjs` counts it from the stylesheet. "In use" is the
number of distinct values once every token is replaced by its value, so it does
not change when a value moves onto a token; "hard-coded" is what still bypasses
a token.

Before the tokens (`src/app.css` on main, 2026-11-16):

| what | distinct in use | hard-coded | uses on a token |
|---|---|---|---|
| font sizes | 10 | 10 | 0 |
| font families | 3 | 3 | 0 |
| colours, with opacity | 61 | 26 | 514 |
| colours, hues only | 24 | 18 | 0 |
| corner radii | 10 | 10 | 0 |
| shadows | 3 | 3 | 0 |
| spacing steps | 22 | 22 | 0 |

After the first mechanical pass (this change):

| what | distinct in use | hard-coded | uses on a token |
|---|---|---|---|
| font sizes | 10 | 2 | 327 |
| font families | 3 | 2 | 0 |
| colours, with opacity | 60 | 12 | 629 |
| colours, hues only | 23 | 7 | 0 |
| corner radii | 10 | 2 | 202 |
| shadows | 3 | 1 | 2 |
| spacing steps | 22 | 14 | 552 |

The values in use did not change (that is the point of the pass); the one
colour that dropped is the ink written two ways (`#16240a` and the same colour
as channels). What the numbers say about the clutter:

- **61 colours but 24 hues.** Most are the ink at different opacities. A
  direction should fix a short list of opacities (for example 12, 25, 50, 65 and
  90%) instead of free choice.
- **Three sizes between 16 and 18px** (`--text-lg`, `--text-xl`, `--text-2xl`)
  are close enough to be one or two.
- **Eight radii** between 4 and 14px read as noise; three (small, medium,
  large) plus pill and round would be enough.
- **22 spacing steps** where 8 would do; 5, 7, 3 and 1px are one-offs.

The direction is chosen (the bud), and the collapse happened in #3656 (the
numbers above are from before it; the table below is after it):

| what | distinct in use | hard-coded | uses on a token |
|---|---|---|---|
| font sizes | 9 | 2 | 329 |
| font families | 3 | 2 | 0 |
| colours, with opacity | 61 | 12 | 631 |
| colours, hues only | 23 | 7 | 0 |
| corner radii | 5 | 0 | 205 |
| shadows | 3 | 1 | 2 |
| spacing steps | 17 | 11 | 583 |

(Counted on the stylesheet the pass was made on. The bud leaves that landed
alongside it bring their own literals, such as the leaf corner shapes and a few
sizes; `node scripts/design-census.mjs` gives the live figures, and moving those
onto tokens belongs to the bud contract.) What the pass did, and the pixels it moved:

- **Text:** 17px (26 uses, dialog and card titles) is now 16px; 18px and 20px
  are `--text-xl` and `--text-2xl`. The stray 10px and 15px sizes (three uses)
  are on 11px and 16px.
- **Radii:** eight steps (4, 6, 8, 10, 12, 14 plus two stray literals) are three,
  `--radius-sm` 4px, `--radius-md` 8px and `--radius-lg` 12px. 6px and 10px went
  to 8px, 14px to 12px.
- **Spacing:** the 14px step now uses `--space-lg` (12px) and the 18px step uses
  `--space-2xl` (16px); both old tokens are gone. The off-scale 3, 5, 7 and 9px literals in
  padding, gap and margin moved to the nearest step.
- **Left as they are, on purpose:** layout constants that are not scale steps
  (the centring margins of -22px, a 32px gutter, the 36 to 56px top padding that
  clears a close button, hairline 1px borders), and one-off colours and the
  90ms press transition. The colours are the in-world labels' translucent
  whites and corals; a later pass can fold them into the palette.
