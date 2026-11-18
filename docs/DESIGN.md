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

## The direction: one bud

The owner was shown three directions as pages to look at (fog and glass, signs in
the world, one bud) and chose the third (2026-11-16, #3540):

> Direction C is real nice. It gives a great combination of aesthetic and
> functionality. We expect users to use gestures with no visible controls, but
> instructions would be quick and easy to find in the bud (at least, that's our
> goal). Let's go full-force into the bud plan. The bud could have the
> higglehaven logo.

Recorded in AGENTS.md as "The interface is one bud". The living reference is
`public/design-directions/c.html` (with `c.css` and `c.js`); A and B stay beside
it as a record and are not built. The tracking issue is #3648, and the bud's own
contract (the names and hooks every leaf builds on) is leaf 1, #3649, and is in
"The bud" below (`src/ui/bud.js`); `c.css` stays the visual reference.

The resting state of the interface is absent. One small, alive, branded thing is
the door to everything else, and findability is paid for by teaching, not by
permanent controls. Four things are built with:

| thing | what it is for | size and shape | how it arrives and leaves | never |
|---|---|---|---|---|
| **the bud** | the only standing piece of interface; carries the higglehaven logo; the door to every petal | `--bud-size` (56px), round, `--shadow-bud`; sits in the bottom-right corner clear of the thumb's resting place; at 55% opacity when idle | breathes slowly (`--motion-breath`); says "Menu" in a small word (`--radius-word`) until first opened, then the word goes | carry a count, a second control, or text that stays after it has been learned |
| **a petal** | one way in: Settings, Friends, Chat, Purchases, Build and Sell, How to move | at least 44px tall and 104px wide, 15px label, `--radius-petal`, pale green fading to pale yellow, `--shadow-petal` | unfolds upward from the bud, 40ms apart, over `--motion-petal` with `--ease-bloom`; folds back when another thing opens | be more than one word, or sit anywhere but over the bud's own column |
| **a leaf** | a thing opened from a petal (Settings, a friend list, a chat) | `--radius-leaf`, `--shadow-leaf`, panel yellow over a soft white wash; grows from the bud's corner and keeps its close in its upper-right | blooms over `--motion-bloom`, with a fog wash rising under it; goes the same way | cover more of the world than it needs, or open on top of another leaf |
| **a card that blooms beside a product** | a product's name, price and Buy, where the product is | `--radius-bloom`, a short stem down to the product, one yellow petal (`--petal-yellow`) for Buy | scales up out of the product over `--motion-bloom`; goes when the person walks on | hide the product it is about |

Everything else is a gesture on the world itself: drag on the left half to walk, drag on
the right half to look, double-tap to fly, tap a product to open its card. A gesture cannot be
seen until it is taught once, so the bud teaches (it pulses and says Menu until
first opened) and the instructions live in it, one tap away. Under
`prefers-reduced-motion` nothing animates.

"Full-force" means no half-way: when a surface moves into the bud, the old
control for it goes in the same change ("One model, not a hybrid" in AGENTS.md).
A session that finds something that cannot be done by gesture, or cannot fit a
petal, says so on #3648; it does not quietly keep the old control.

## How to use the tokens

Every value below is a CSS custom property in `src/tokens.css`, loaded before
`src/app.css` by `index.html`. Write `var(--token)`, never the literal. If a
value you need is not here, add a token (and name it on this page) instead of
a literal, so a later restyling is one edit.

The admin pages (`public/admin-*.css`) keep their plain utility look and are
not on this system.

The first pass of tokens carried the values the stylesheet already used, so
adopting them changed nothing on screen (checked by substituting every token
back and comparing with the old file). The owner has since chosen the bud (next
section); its tokens are in `src/tokens.css` under "The bud". The old tokens keep
their values until a bud leaf moves a surface onto the new ones; collapsing the
near-duplicates listed under "Where the clutter is" is a separate reviewed pass.

## Colour

The palette is two pale surfaces and one ink, with one saturated green for the
active state and one coral for danger.

| token | value | use |
|---|---|---|
| `--ink-rgb` | `22 36 10` | the one dark-green ink, as channels so a use can pick its own opacity: `rgb(var(--ink-rgb) / 0.25)` |
| `--ink` | the ink as a colour | text and lines on either pale surface |
| `--pill-rgb` | `214 232 190` | the small floating HUD chrome: pale green |
| `--panel-rgb` | `250 240 199` | large, text-heavy dialogs: pale yellow |
| `--pill-text` | the ink | text on a pale surface |
| `--pill-text-soft` | the ink at 65% | secondary text on a pale surface |
| `--brand-green` | `#6ca42e` | the active state only; a step up in intensity from the pale surfaces |
| `--spring-green-rgb` | `62 199 91` | the movement controls' resting state, brighter than the brand green |
| `--danger` | `#e2694f` | the one accent for destructive actions: a friendly coral, not a dark red |
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

The opacities a surface may use are a short list, not free choice:

| token | value | use |
|---|---|---|
| `--alpha-faint` | 0.12 | a quiet fill or a track |
| `--alpha-line` | 0.25 | a hairline border |
| `--alpha-half` | 0.5 | a tinted well; disabled |
| `--alpha-soft` | 0.65 | secondary text, a resting pill |
| `--alpha-strong` | 0.9 | a surface that text sits on |

Today HUD chrome is a pale-green pill at 0.65 to 0.95 opacity, and dialogs are
a pale-yellow panel at 0.97. No surface blurs what is behind it. Borders are
one pixel at ink 25% where they exist at all.

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

The world's own motion (fog that resolves into a thing, drift) lives in the
scene code, not in CSS; see "Things arrive in the world through fog" in AGENTS.md.
Nothing bounces, snaps or slides in from off screen.

## Never

- A heavy or dark panel, a black or near-black surface, a thick border.
- A box inside a box inside a box. One surface, then content.
- More than one typeface, or text smaller than `--text-2xs`.
- A literal colour, size, radius or space in `src/app.css` where a token exists.
- A control that is only an icon with no name for a person using a screen reader.
- A confirmation that can be missed (see AGENTS.md), however light the dress.
- A new popup for something that could be said in the world.

## The bud

The owner chose direction C, "one bud" (#3648). In Shop the only standing
interface is one small, slowly glowing bud in a corner, carrying the
higglehaven logo; until it has been opened once it pulses and says Menu.
Tapping it unfolds petals; a petal runs an action or opens a leaf (a soft sheet
by the bud, close control upper right, one at a time). Everything else is done
by touching the world. The module is `src/ui/bud.js`:

- `registerBudPetals(mode, [{ id, label, run }])`: one definition per mode
  (`shop`, `build`, `sell`). A mode with none has no bud, and keeps its old
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
- `setBudMark(key)` and `clearBudMark(key)`: any key set shows the bud's one
  unread mark; it clears when none are left.
- The bud is the existing account toggle and its petals are the buttons of the
  account panel, so a row there is already a petal. Do not rebuild a panel to
  make a petal; move it, and remove the old control in the same change.
- Settings is a leaf in the same way (#3652): a soft sheet at the bud's corner with no
  dimming scrim, so the world shows around it; it stays inside the screen and scrolls
  inside itself. A panel that moves into the bud takes this look, not a full-screen
  dialog.
- The three modes are a petal group of their own, a half-ring at the bud's corner (#3723):
  Shop, Build and Sell are `.mode-nav-btn` buttons in `#bud-modes`, hidden until the bud
  is unfolded, the same three in every mode with the current one green and `aria-current`.
  They sit 100px from the bud's centre at 10, 45 and 80 degrees, so no two touch, and the
  column of things you open starts 92px lower, under them. The arc opens away from the
  screen edge: the ring's two direction variables are +1 for a top-left bud and -1 for one in the
  bottom-right (set `body[data-bud-corner="bottom-right"]`). A mode is never a petal of the
  column, and the ring is last in reading order.
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
