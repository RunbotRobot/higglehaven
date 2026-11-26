// #3690 (Build in the bud, 3/6, part of #3654 and #3648): the Undo/Redo pair (since #4411 a standing row) and the
// Levels leaf, built on the bud contract (src/ui/bud.js, docs/DESIGN.md "The bud").
//
// What they replace, in this same change ("the old control goes in the same change"):
//   - the Undo and Redo pills in the top-right row  ->  one petal with both halves
//   - the "Ground" pill and its dropdown            ->  the Levels petal and its leaf
//
// Nothing here re-implements what the controls do. The buttons are the same elements with
// the same ids and handlers (src/build/scene.js owns what Undo, Redo, Up, Down, Build and
// Dig do, and when they are enabled); this module only moves them into the bud and decides
// when the petal is drawn. Other Build slices add their own petals with addBudPetals.
import { addBudPetals, openLeaf, closeLeaf, setBudWord, clearBudWord } from '../ui/bud.js';
import { svgIcon } from '../ui/budIcons.js';
import { isBrushInItemCard, syncBrushHost } from './itemCard.js';

const byId = (id) => document.getElementById(id);

// ---- Undo / Redo: a small standing row (#4411) ----------------------------------------------

// The owner's own exception to "Nothing stands on the world but the head", for Build: Undo and Redo are reached many
// times a minute while building, so they stand as two small icons in one fixed row at the upper right, always drawn,
// greyed when there is nothing to undo or redo. They used to be a petal that was only drawn while the bud was open.
// scene.js owns what they do and when they are enabled; this only gives each its picture.
function dressUndoRedoRow() {
  for (const [id, key, name] of [['undo-btn', 'undo', 'Undo'], ['redo-btn', 'redo', 'Redo']]) {
    const button = byId(id);
    if (!button || button.querySelector('svg')) continue;
    button.textContent = '';
    button.append(svgIcon(key));
    button.setAttribute('aria-label', name);
    button.title = name;
  }
}

// ---- Levels: a leaf that says where you are, with Build above and Dig below ----------------

// The level label and the panel with Up/Down/Build/Dig/Remove and their status line live,
// hidden, in #level-controls. The leaf borrows them while it is open and gives them back as
// it closes, so scene.js keeps the same elements to update and the same handlers on them.
function openLevelsLeaf() {
  openLeaf({
    id: 'levels',
    title: 'Levels',
    render: (body) => {
      const line = document.createElement('p');
      line.className = 'bud-level-line';
      line.append('You are on ', byId('level-label'));
      body.append(line, byId('level-menu-panel'));
      // #4331: the cap is read as the leaf opens (scene.js listens), so the buttons are drawn by what it leaves.
      document.dispatchEvent(new CustomEvent('hh-levels-leaf-opened'));
    },
    onClose: () => {
      const home = byId('level-controls');
      if (!home) return;
      home.append(byId('level-label'), byId('level-menu-panel'));
    },
  });
}

// ---- Tools: Measure, Multi-Select (with its brush) and Paste -----------------------------

// #3691 (Build in the bud, 4/6). The four controls wait, hidden, in #tool-controls. The leaf
// borrows them while it is open and gives them back as it closes, so scene.js keeps the same
// elements to update and the same handlers on them: what Measure, Multi-Select and Paste do
// is unchanged. Paste (hidden until something is copied, #3574) is simply not listed until
// then, because scene.js leaves its `hidden` attribute alone and so does this.
// #4201: Removed items joins them (it used to stand on the world beside Undo); it stays hidden until something is pending.
const TOOL_IDS = ['toggle-multiselect', 'multiselect-brush-control', 'toggle-measure', 'toggle-ghosts', 'paste-btn', 'pending-restoration-btn'];

function openToolsLeaf() {
  openLeaf({
    id: 'tools',
    title: 'Tools',
    render: (body) => {
      const list = document.createElement('div');
      list.className = 'bud-tools';
      // #3691: while the item card hosts the brush slider beside the selection, the leaf does not take
      // it away (one slider, one place).
      for (const id of TOOL_IDS) {
        if (id === 'multiselect-brush-control' && isBrushInItemCard()) continue;
        list.append(byId(id));
      }
      body.append(list);
      // Choosing a tool puts the leaf away so the world is clear to use it on; the bud then
      // wears the tool's name (below) until it is switched off. Paste starts a placement, which
      // needs the world too. The brush slider keeps the leaf open: it is being adjusted.
      list.addEventListener('click', (event) => {
        if (event.target.closest('#toggle-multiselect, #toggle-measure, #toggle-ghosts, #paste-btn, #pending-restoration-btn')) setTimeout(closeLeaf, 0);
      });
    },
    onClose: () => {
      const home = byId('tool-controls');
      if (!home) return;
      for (const id of TOOL_IDS) {
        if (id === 'multiselect-brush-control' && isBrushInItemCard()) continue;
        home.append(byId(id));
      }
      syncBrushHost();
    },
  });
}

// "While a tool is on, the bud wears its name": scene.js sets aria-pressed on the two toggles
// (and clears it on its own, e.g. after a Copy ends Multi-Select), so follow that rather than
// the clicks.
function wearToolNames() {
  const names = [['toggle-multiselect', 'Selecting'], ['toggle-measure', 'Measuring']];
  const sync = () => {
    const on = names.find(([id]) => byId(id)?.getAttribute('aria-pressed') === 'true');
    if (on) setBudWord('build-tool', on[1]);
    else clearBudWord('build-tool');
  };
  const watcher = new MutationObserver(sync);
  for (const [id] of names) {
    const el = byId(id);
    if (el) watcher.observe(el, { attributes: true, attributeFilter: ['aria-pressed'] });
  }
  sync();
}

if (typeof document !== 'undefined') {
  dressUndoRedoRow();
  addBudPetals('build', [
    { id: 'levels', label: 'Levels', run: openLevelsLeaf },
    { id: 'tools', label: 'Tools', run: openToolsLeaf },
  ]);
  wearToolNames();
}
