// #3690 (Build in the bud, 3/6, part of #3654 and #3648): the Undo/Redo pair petal and the
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
import { addBudPetals, refreshBud, openLeaf, closeLeaf, setBudWord, clearBudWord } from '../ui/bud.js';

const byId = (id) => document.getElementById(id);

// ---- Undo / Redo: one petal, two halves ------------------------------------------------

// "Drawn only when there is something to undo or redo": scene.js enables Undo while a
// change can be undone, and shows Redo only while one can be redone.
function somethingToUndoOrRedo() {
  const undo = byId('undo-btn');
  const redo = byId('redo-btn');
  return Boolean(undo && !undo.disabled) || Boolean(redo && !redo.hidden && !redo.disabled);
}

function undoRedoPetal() {
  const undo = byId('undo-btn');
  const redo = byId('redo-btn');
  const pair = document.createElement('div');
  pair.id = 'bud-undo-redo';
  pair.className = 'bud-pair';
  pair.append(undo, redo);
  // scene.js flips `disabled` and `hidden` on the two buttons as the history changes; follow
  // them, so the petal appears and goes without scene.js knowing the bud exists.
  const watcher = new MutationObserver(refreshBud);
  watcher.observe(undo, { attributes: true, attributeFilter: ['disabled', 'hidden'] });
  watcher.observe(redo, { attributes: true, attributeFilter: ['disabled', 'hidden'] });
  return { id: 'undo-redo', element: pair, visible: somethingToUndoOrRedo };
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
const TOOL_IDS = ['toggle-multiselect', 'multiselect-brush-control', 'toggle-measure', 'paste-btn'];

function openToolsLeaf() {
  openLeaf({
    id: 'tools',
    title: 'Tools',
    render: (body) => {
      const list = document.createElement('div');
      list.className = 'bud-tools';
      for (const id of TOOL_IDS) list.append(byId(id));
      body.append(list);
      // Choosing a tool puts the leaf away so the world is clear to use it on; the bud then
      // wears the tool's name (below) until it is switched off. Paste starts a placement, which
      // needs the world too. The brush slider keeps the leaf open: it is being adjusted.
      list.addEventListener('click', (event) => {
        if (event.target.closest('#toggle-multiselect, #toggle-measure, #paste-btn')) setTimeout(closeLeaf, 0);
      });
    },
    onClose: () => {
      const home = byId('tool-controls');
      if (!home) return;
      for (const id of TOOL_IDS) home.append(byId(id));
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
  addBudPetals('build', [
    undoRedoPetal(),
    { id: 'levels', label: 'Levels', run: openLevelsLeaf },
    { id: 'tools', label: 'Tools', run: openToolsLeaf },
  ]);
  wearToolNames();
}
