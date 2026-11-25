// #3689 (leaf 2/6 of #3654, under the bud, #3648): the one mechanism for a card that
// blooms BESIDE a thing in the world. #3651's product card (Shop) wrote it first;
// the card of a selected item in Build is the second user, so the projection, the
// placement writes and the bloom state live here once rather than twice (standing
// decision "One model, not a hybrid").
//
// A card element needs `data-state` ('closed' | 'blooming' | 'open'), `data-side`
// and `data-edge` (CSS reads them, see `.world-card` in src/app.css) and the custom
// properties --card-x / --card-y / --pointer-x / --pointer-y, all written here.
// The arithmetic of where a card sits is pure and unit-tested in
// src/shop/productCardLayout.js; this file is the camera projection and the writes.
// One project() per frame while a card is open, and a style write only when the
// placement actually changes ("Moving, looking and drawing never wait on loading").
import * as THREE from 'three';
import { camera } from '../world/scene.js';
import { clampAnchorRadius, placeProductCard } from '../shop/productCardLayout.js';

// The bloom's own length (--motion-bloom is 0.45s) plus a little: how long a card
// stays in its 'blooming' state if no animationend ever arrives (a browser that
// skips animations, a hidden tab).
const BLOOM_FALLBACK_MS = 800;

const scratchRight = new THREE.Vector3();
const scratchForward = new THREE.Vector3();
const scratchProjected = new THREE.Vector3();

export function createWorldCard(cardEl) {
  let measuredSize = { width: 240, height: 120 };
  let sizeDirty = true;
  let lastPlacement = null;
  let bloomTimer = null;
  // Where the last frame put the thing on screen. Read only by e2e hooks;
  // recomputed every frame the card is open.
  let lastAnchor = null;

  function setBloomState(state) {
    clearTimeout(bloomTimer);
    cardEl.dataset.state = state;
    if (state === 'blooming') {
      bloomTimer = setTimeout(() => {
        if (cardEl.dataset.state === 'blooming') cardEl.dataset.state = 'open';
      }, BLOOM_FALLBACK_MS);
    }
  }

  cardEl.addEventListener('animationend', (event) => {
    if (event.target === cardEl && cardEl.dataset.state === 'blooming') setBloomState('open');
  });

  function measure() {
    const width = cardEl.offsetWidth;
    // #4118: the card's whole content height, not what is shown, or a card shortened to fit would measure as short
    // and the next frame would put it back beside the thing at full height.
    const height = Math.max(cardEl.offsetHeight, cardEl.scrollHeight);
    if (width > 0 && height > 0) measuredSize = { width, height };
    sizeDirty = false;
  }

  return {
    // The card's content changed size (its text, a petal shown or hidden).
    markDirty() {
      sizeDirty = true;
    },
    // Forget the last placement so the next place() writes again (a card that
    // is about to be shown for a different thing).
    resetPlacement() {
      lastPlacement = null;
    },
    anchor() {
      return lastAnchor;
    },
    // Restart the bloom, also for a different thing while a card is open.
    bloom() {
      setBloomState('closed');
      // eslint-disable-next-line no-unused-expressions
      cardEl.offsetWidth;
      setBloomState('blooming');
    },
    close() {
      lastPlacement = null;
      lastAnchor = null;
      clearTimeout(bloomTimer);
      cardEl.dataset.state = 'closed';
      cardEl.hidden = true;
    },
    // worldPosition: a THREE.Vector3 (the thing's centre); halfSize: half its
    // largest dimension in metres.
    // minRadiusPx (optional): a clear space to keep round the thing, for a card whose thing wears
    // handles that reach past its own size (Build's rings, #4118): the card sits beyond it.
    place(worldPosition, halfSize, minRadiusPx = 0) {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      camera.getWorldDirection(scratchForward);
      const behind = scratchProjected.copy(worldPosition).sub(camera.position).dot(scratchForward) <= camera.near;
      let anchor;
      if (behind) {
        anchor = { x: NaN, y: NaN, radius: 0, behind: true };
      } else {
        scratchProjected.copy(worldPosition).project(camera);
        const x = (scratchProjected.x * 0.5 + 0.5) * viewport.width;
        const y = (-scratchProjected.y * 0.5 + 0.5) * viewport.height;
        // The thing's on-screen radius: how far a point half its size away,
        // sideways to the camera, lands from its centre.
        scratchRight.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(halfSize).add(worldPosition).project(camera);
        const rightX = (scratchRight.x * 0.5 + 0.5) * viewport.width;
        anchor = { x, y, radius: clampAnchorRadius(Math.max(Math.abs(rightX - x), minRadiusPx)), behind: false };
      }
      lastAnchor = anchor;

      if (sizeDirty) measure();
      // #4118: the side it had is passed back in, so a thing on the middle of the screen does not flip the card.
      const place = placeProductCard({ anchor, card: measuredSize, viewport, previousSide: lastPlacement?.side ?? null });
      const left = Math.round(place.left * 2) / 2;
      const top = Math.round(place.top * 2) / 2;
      const pointerY = Math.round(place.pointerY);
      const pointerX = Math.round(place.pointerX);
      const last = lastPlacement;
      const maxHeight = place.maxHeight ?? null;
      if (last && last.left === left && last.top === top && last.side === place.side
        && last.edge === place.edge && last.pointerY === pointerY && last.pointerX === pointerX
        && last.maxHeight === maxHeight) return;
      lastPlacement = {
        left, top, side: place.side, edge: place.edge, pointerY, pointerX, maxHeight,
      };
      if (maxHeight === null) cardEl.style.removeProperty('--card-max-height');
      else cardEl.style.setProperty('--card-max-height', `${maxHeight}px`);
      cardEl.dataset.capped = maxHeight === null ? 'false' : 'true';
      cardEl.style.setProperty('--card-x', `${left}px`);
      cardEl.style.setProperty('--card-y', `${top}px`);
      cardEl.style.setProperty('--pointer-y', `${pointerY}px`);
      cardEl.style.setProperty('--pointer-x', `${pointerX}px`);
      cardEl.dataset.side = place.side;
      cardEl.dataset.edge = place.edge ? 'true' : 'false';
    },
  };
}
