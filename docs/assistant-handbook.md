# Assistant handbook

The exact steps for what a person might ask an assistant how to do, in the words
and pictures the app shows. An assistant reads this before answering a "how do I"
question, and answers from it instead of from memory. `docs/assistant-runbook.md`
says who an assistant is and what it may do; this says how the app works.

Nothing here is read by a shopper, but everything is written the way an assistant
would say it: plain words, short steps, the product's own vocabulary ("lándlet",
always, with the accent).

## How an entry is written

Every entry has the same parts, in this order, so the next chapter can be copied
from this one and a test can check them:

- **A title that is the person's question**, ending in a question mark.
- **Numbered steps.** Each step names the control by the words on it, in quotes
  ("Add Item"), or by what it looks like when it has no words (the bird button, the
  gear). It says what to tap, not where the code keeps it. Where the app's own
  words are not yet spelled the way the product spells them, quote only the part
  that is, so the step stays true when the spelling is fixed.
- **`**You will see:**`** one or two sentences on what changes on screen after the
  last step.
- **`**If something goes wrong:**`** two or three bullets: what commonly goes
  wrong and what to do. Where the app says something, say what it says. Where it
  does not, do not invent: tell the person to read out what they see, and offer to
  pass it to the team (the runbook's "not sure" rule).
- **A controls block** (a fenced block whose first line is `controls` and a mode),
  one control per line as `selector | words`. Every control the steps name is
  listed with the words it must still carry. `scripts/assistant-handbook-lib.mjs`
  checks that the entry's text names each one, and
  `e2e/assistant-handbook-controls.test.mjs` opens the real app at 390x844 and
  fails when a listed control is gone or no longer carries those words. The mode
  is where the control lives: `any`, `shop`, `build` or `sell`.

**When you change the interface:** a button you rename, move or remove has to be
fixed here in the same pull request. Find it by its old words or selector in this
file, change the steps and the controls line together, and run
`e2e/assistant-handbook-controls.test.mjs`. If a step is no longer true and you
cannot rewrite it, delete the entry rather than leave it wrong: an assistant with
no entry says it is unsure, which is better than a confident wrong answer.

Money, identity and an account's standing are not explained here. An entry that
touches one ends by sending the assistant to the runbook's hand-off.

## Build

### How do I get my own lándlet?

1. Tap "Build" at the top right.
2. The first time, a sheet opens with the title "Claim a" and a small map.
   Green squares are "Available", grey are "Claimed", blue is "Water".
3. Tap an available green square on the map. The line under the map names it and
   its size, and the "Claim" button turns on.
4. Tap "Claim". The sheet closes and you are standing on your own lándlet.

**You will see:** the sheet goes away and the Build buttons appear: "+ Add Item",
"Multi-Select" and "Measure" at the bottom left, "Undo" at the top right.

**If something goes wrong:**
- The line under the map says "No lándlets are ready to claim yet — check back
  again shortly." Tap "Refresh" after a moment. If it stays that way, offer to
  pass it to the team.
- The "Claim" button stays off: nothing is chosen yet. Tap a green square first.
- The sheet says you can only claim one lándlet. Choose carefully before tapping
  "Claim".

```controls any
.mode-nav-btn[data-mode="build"] | Build
#claim-modal h2 | Claim a
#claim-confirm-btn | Claim
#claim-refresh-btn | Refresh
```

### How do I add an item to my lándlet?

1. In Build, tap "+ Add Item" at the bottom left. A list opens.
2. Look through the list, or type in the "Search" box. "All", "Products" and
   "Bundles" narrow it to everything, single items or saved bundles.
3. Tap an item's name. The list closes and the top of the screen says "Tap a spot
   to place" and the item's name.
4. Tap the ground where you want it.

**You will see:** the item stands where you tapped and is already selected, with a
row of buttons above it ("Move", "Rotate" and the rest) and arrows around it.

**If something goes wrong:**
- Changed your mind before tapping the ground: the "+ Add Item" button now reads
  "Cancel". Tap it.
- The item is not where you wanted. It is selected, so use "Move" (below), or tap
  "Undo" at the top right to take it back.
- Nothing seems to happen when tapping the ground: ask what the top of the screen
  says, and offer to pass it to the team if it does not explain.

```controls any
#add-item-btn | Add Item
#catalog-search-input | Search
.search-scope-btn[data-search-scope="both"] | All
.search-scope-btn[data-search-scope="products"] | Products
.search-scope-btn[data-search-scope="bundles"] | Bundles
#undo-btn | Undo
```

### How do I move an item?

1. Tap the item. It gets arrows around it and a row of buttons above it.
2. Make sure "Move" is the green one in that row. Tap it if not.
3. Drag the item to slide it along the ground. Drag the blue arrow to lift it up
   or down. Drag the red or green arrow to slide it along only that line.
4. Let go where you want it. It saves by itself.

**You will see:** the item follows your finger and stays where you leave it.

**If something goes wrong:**
- It will not go any further: it has reached a limit and the app stops it there,
  saying so at the top of the screen. If the message is about how high or how deep
  the lándlet goes, see the levels entry below.
- You want to line it up with something nearby: tap "Snap" so it is green. A
  dragged item then lines its edges and middle up with items close to it.
- Wrong spot: "Undo" at the top right.

```controls build
#mode-move | Move
#toggle-snap | Snap
```

### How do I turn an item?

1. Tap the item, then tap "Rotate" in the row above it. Three coloured rings
   appear around it, and a line at the top reads the angles.
2. Drag the blue ring to turn it flat, like a record on a turntable. The line
   calls this "Turn".
3. Drag the red or green ring to tip it over. The line calls these "Tilt".
4. Tap "Move" to go back to sliding it.

**You will see:** the item turns as you drag, and the line at the top shows how far.

**If something goes wrong:**
- It turned the wrong way or too far: "Undo" at the top right.
- A bundle says "This bundle is too big to turn any further here." It cannot turn
  more without leaving your lándlet. Move it first, or turn it the other way.

```controls build
#mode-rotate | Rotate
#mode-move | Move
```

### How do I copy an item?

1. Tap the item, then tap "Copy" in the row above it. The top of the screen says
   "Copied 1 item".
2. Tap "Paste" at the bottom left. With the item still selected, the copy appears
   right on top of it.
3. To put the copy somewhere else instead, tap empty ground first so nothing is
   selected, then tap "Paste". The top of the screen says "Tap a spot to paste 1
   item": tap the ground where it should go.
4. The copy is selected, so use "Move" to place it exactly.

**You will see:** a second item, the same as the first.

**If something goes wrong:**
- Changed your mind about where to paste: the "+ Add Item" button now reads
  "Cancel". Tap it.
- Wrong spot: "Undo" at the top right.

```controls build
#copy-item | Copy
#paste-btn | Paste
```

### How do I remove an item, or get it back?

1. Tap the item.
2. Tap "Delete" in the row above it.

**You will see:** the item disappears at once. There is no "are you sure" for a
single item.

**If something goes wrong:**
- It was a mistake: tap "Undo" at the top right straight away and it comes back.
- It is gone and "Undo" no longer brings it back: items taken off by the world
  itself (for example because their seller was suspended) wait under "Removed
  Items". If that button shows, tap it. Otherwise offer to pass it to the team.

```controls build
#delete-item | Delete
#undo-btn | Undo
#pending-restoration-btn | Removed Items
```

### How do I undo a mistake, or redo it?

1. Tap "Undo" at the top right. The last thing you did is taken back: a move, a
   turn, an add, a removal.
2. Tap it again to go back further.
3. If you went too far, "Redo" appears under it. Tap it to put things back.

**You will see:** the item jumps back to how it was. "Redo" shows up only after an
"Undo".

**If something goes wrong:**
- "Undo" is greyed out: there is nothing to take back yet.
- "Redo" has gone: it only shows while there is something to put back.

```controls build
#undo-btn | Undo
#redo-btn | Redo
```

### How do I select several items at once?

1. Tap "Multi-Select" at the bottom left so it turns green. A "Brush" slider
   appears.
2. Tap each item you want, or drag across several: the slider sets how wide the
   sweep is.
3. The top of the screen says how many are chosen, for example "2 items
   selected".
4. Tap "Multi-Select" again when you want to go back to choosing one item at a
   time.

**You will see:** the same row of buttons as for one item, acting on all of them:
"Move", "Rotate", "Copy", "Delete" and the rest.

**If something goes wrong:**
- Some buttons in the row are greyed out, such as "Trim": they work on one item at
  a time.
- The row of buttons and the count at the top only show once something is
  chosen.

```controls build
#toggle-multiselect | Multi-Select
#multiselect-brush-size-input | brush
#mode-move | Move
```

### How do I make a bundle, and use it again?

1. Select two or more items (see the entry above).
2. Tap "Bundle" in the row above them. They become one thing: one box around them,
   moved and turned together.
3. To keep it for later, tap "Save Bundle", give it a name, choose whether
   "Anyone can place this bundle" or "Only you can place this bundle", and tap
   "Save".
4. To use a saved bundle, tap "+ Add Item", then "Bundles", and tap its name.
5. To split one apart, select it and tap "Unbundle".

**You will see:** after "Bundle" the buttons "Unbundle" and "Edit" appear. After
"Save", a saved bundle is in the "+ Add Item" list under "Bundles".

**If something goes wrong:**
- The app says "Still saving your items. Try Bundle again in a moment." Wait a
  few seconds and tap "Bundle" again.
- "Edit" on a saved bundle changes every copy of it, and only the person who
  saved it can do that. Anyone else can tap "Unbundle" and keep their own.

```controls build
#group-item | Bundle
#save-bundle-item | Save Bundle
#ungroup-item | Unbundle
#edit-bundle-item | Edit
#bundle-name-save-btn | Save
label:has(#bundle-name-share-public) | Anyone can place this bundle
label:has(#bundle-name-share-private) | Only you can place this bundle
```

### How do I build up or dig down to another level?

1. Tap the pill at the bottom, which reads "Ground" when you are on the ground
   level. A small menu opens.
2. Tap "Build Level Above" to add a level over the one you are on, or "Dig Level
   Below" to add one underneath. The button shows in brackets how much space the
   new level uses.
3. Use the up and down arrows ("Level up", "Level down") to move between levels.
   The pill shows which level you are on.
4. On a level above or below the ground, "Remove This Level" appears. It removes
   that level.

**You will see:** the world shifts to the new level and the pill's name changes.

**If something goes wrong:**
- The app says "That's as high as this lándlet goes. Use Build Level Above to
  build higher." or "That's as deep as this lándlet goes. Use Dig Level Below to
  go deeper." It means an item has hit the top or bottom level you have.
- Adding a level is refused: the app says why in words. Read it out with the
  person and do not promise more than it says. If money or allowances are
  involved, use the runbook's hand-off.
- "Remove This Level" takes the items on that level off your lándlet. Say so
  before the person taps it.

```controls build
#level-menu-toggle | Ground
#level-build-btn | Build Level Above
#level-dig-btn | Dig Level Below
#level-up-btn | Level up
#level-down-btn | Level down
#level-remove-btn | Remove This Level
```

### How do I measure something?

1. Tap "Measure" at the bottom left so it turns green.
2. Tap one point: an item's surface or the bare ground. Tap a second point.
3. The top of the screen reads the straight-line distance and how much of it is
   across, along and up, for example "5.83m — Δx 0.55m, Δy 5.80m, Δz 0.00m".
4. Drag either point to adjust it, or tap somewhere else to start a new
   measurement. Tap "Measure" again to turn it off.

**You will see:** two small markers joined by a dashed line, and the numbers at the
top of the screen.

**If something goes wrong:**
- Nothing is read out: tap "Measure" first, then both points.
- Taps select items instead: "Measure" is off. Tap it so it is green.

```controls build
#toggle-measure | Measure
```
