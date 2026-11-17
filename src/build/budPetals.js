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
import { addBudPetals, refreshBud, openLeaf } from '../ui/bud.js';

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

if (typeof document !== 'undefined') {
  addBudPetals('build', [
    undoRedoPetal(),
    { id: 'levels', label: 'Levels', run: openLevelsLeaf },
  ]);
}
