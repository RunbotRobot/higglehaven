import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fetchWorld, fetchAllLandlets, claimLandlet } from '../api.js';
import { formatArea } from '../settings.js';
import { curvedPosition } from '../../worker/earthCurvature.js';
import { shapeForLandlet, plotColorKeyForLandlet, openModalA11y, closeModalA11y, START_MODE_KEY } from '../main.js';

// #2564 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): the mandatory first-claim flow a
// builder with no claimed landlet yet is dropped into — a self-contained
// flyover map over the whole world, letting them pick any available
// (greenbelt) plot. Already the cleanest, already-correct module boundary
// in the whole file per #2503's design: this flow declares its own
// locally-scoped raycaster/camera/renderer (shadowing the module-level
// names other extracted modules use for the main builder scene), and reads
// nothing from main.js except shapeForLandlet/plotColorKeyForLandlet (both
// shared with Shop/Build mode's own plot rendering) and
// openModalA11y/closeModalA11y/START_MODE_KEY, which still live in main.js
// pending #2550's ui/modal.js extraction — see each import's own re-export
// comment in main.js for why that's a temporary circular import rather than
// a real one, and why it's harmless here (every use on both sides is inside
// a function body, never read at module-evaluation time).

const claimModalEl = document.getElementById('claim-modal');
const claimMapCanvas = document.getElementById('claim-map-canvas');
const claimStatusEl = document.getElementById('claim-status');
const claimRefreshBtn = document.getElementById('claim-refresh-btn');
const claimBackBtn = document.getElementById('claim-back-btn');
const claimSelectionNameEl = document.getElementById('claim-selection-name');
const claimConfirmBtn = document.getElementById('claim-confirm-btn');

export function runClaimFlow() {
  return new Promise((resolve) => {
    claimModalEl.classList.add('visible');
    // No closeFn: this flow has no cancel action (claimBackBtn reloads the
    // page rather than dismissing the modal in place — see its own comment
    // below), so Escape intentionally does nothing here rather than
    // silently abandoning a mandatory first-claim flow.
    openModalA11y(claimModalEl, null);
    loadLandletMap(resolve);
    claimRefreshBtn.onclick = () => loadLandletMap(resolve);
    // A reload rather than trying to unwind this modal in place — the
    // same clean-slate escape hatch #mode-nav's own Shop/Build switching
    // uses, and for the same reason: there's nothing built yet here to
    // preserve, so starting bootstrap() over from scratch is simpler than
    // reasoning about every way this could be left dangling (the builder
    // this flow is claiming for getting deleted out from under it, say).
    // Targets 'shop', not 'build': a builder with nothing claimed yet who
    // backs out of this flow has nothing left to build on, same as
    // declining to log in (see bootstrap()'s own fallback) — targeting
    // 'build' here used to land back in resolveLandletId(), which finds
    // the same still-unclaimed builder and immediately reopens this exact
    // modal, an inescapable loop that also blocked reaching the account
    // menu (it sits under this modal's z-index) to log out at all.
    claimBackBtn.onclick = () => {
      sessionStorage.setItem(START_MODE_KEY, 'shop');
      location.reload();
    };
  });
}

// A self-contained Three.js scene/camera/renderer/controls for the claim
// modal, entirely separate from the main builder scene (which hasn't loaded
// any content yet at this point anyway) so it can be freely created and
// torn down each time the modal opens without touching builder state.
let claimFlyover = null;

// loadLandletMap awaits a fetch before building its scene; if Refresh is
// clicked again before that fetch resolves, disposeClaimFlyover() at the
// new call's start is a no-op (claimFlyover is still null either way), so
// without this guard both calls would go on to build a full scene, attach
// their own canvas click/resize listeners, and race to overwrite the
// shared claimFlyover — leaking one call's listeners/RAF loop forever.
// Each call captures the token's value *before* it starts awaiting, then
// checks it's still the latest afterward; a superseded call bails out
// quietly instead of building anything.
let claimMapLoadToken = 0;

function disposeClaimFlyover() {
  if (!claimFlyover) return;
  cancelAnimationFrame(claimFlyover.animationHandle);
  window.removeEventListener('resize', claimFlyover.onResize);
  // #1131: this used to be the one listener loadLandletMap attaches that
  // never got removed here — every completed load (not just a raced-out
  // in-flight one, which claimMapLoadToken already guards against) left
  // its own 'click' listener on claimMapCanvas permanently, each closing
  // over this exact scene/plotMeshes/etc. Every ordinary Refresh click or
  // failed-claim retry (claimSelectedLandlet's own catch calls
  // loadLandletMap again) leaked one more, forever. Removed the same way
  // onResize already is just above.
  claimMapCanvas.removeEventListener('click', claimFlyover.onCanvasClick);
  claimFlyover.controls.dispose();
  claimFlyover.renderer.dispose();
  for (const mesh of claimFlyover.plotMeshes) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  for (const outline of claimFlyover.plotOutlines) outline.geometry.dispose();
  claimFlyover.plotOutlineMaterial.dispose();
  claimFlyover.selectionOutline?.geometry.dispose();
  claimFlyover.selectionOutlineMaterial.dispose();
  claimFlyover = null;
}

// Matches SHOP_PLOT_COLORS' own claimed color (see its comment) so the
// claim-map flyover and the real 3D world it's picking a plot in agree.
const CLAIM_PLOT_COLORS = { greenbelt: 0x6ca42e, claimed: 0xc2a878, water: 0x4a9bd1 };

// docs/SPEC.md §1's Earth-curvature ground (issue #135, worker/
// earthCurvature.js) applied to this flyover — the one place in this app
// that currently renders many landlets across a real fraction of the
// world's own radius at once. A single landlet's own ~31.6m ground plane
// (Build/Shop mode's flat ground meshes, deliberately left untouched)
// sags by a fraction of a millimeter at Earth's real radius — genuinely
// imperceptible, the same "correct architecture, imperceptible at this
// scale" tradeoff docs/SPEC.md §3 already makes for the buildable-volume
// cone (see clampToLandlet/footprintScaleAtHeight above). This flyover's
// own radius (the world's current growth radius) is the only distance
// this app deals with that's large enough for that sag to eventually
// matter, so it's the one ground mesh actually worth curving today.
//
// Builds a triangulated disc — ringCount concentric rings (plus a center
// point) of angularSegments vertices each — with every vertex run through
// curvedPosition, rather than THREE.CircleGeometry's flat single-ring fan
// (which has no interior vertices to displace at all). Reused for both
// the ground fill (a full disc from r=0) and the world-boundary ring
// (innerRadius > 0, an annulus with no center fan) via buildCurvedRingBand
// below.
function buildCurvedDiscGeometry(radius, ringCount, angularSegments) {
  const positions = [];
  const center = curvedPosition({ x: 0, y: 0, z: 0 });
  positions.push(center.x, center.y, center.z);
  const ringStart = [];
  for (let ring = 1; ring <= ringCount; ring++) {
    ringStart[ring] = positions.length / 3;
    const r = (radius * ring) / ringCount;
    for (let a = 0; a < angularSegments; a++) {
      const theta = (a / angularSegments) * Math.PI * 2;
      const point = curvedPosition({ x: r * Math.cos(theta), y: r * Math.sin(theta), z: 0 });
      positions.push(point.x, point.y, point.z);
    }
  }
  const indices = [];
  for (let a = 0; a < angularSegments; a++) {
    const next = (a + 1) % angularSegments;
    indices.push(0, ringStart[1] + a, ringStart[1] + next);
  }
  for (let ring = 1; ring < ringCount; ring++) {
    const inner = ringStart[ring];
    const outer = ringStart[ring + 1];
    for (let a = 0; a < angularSegments; a++) {
      const next = (a + 1) % angularSegments;
      indices.push(inner + a, outer + a, outer + next);
      indices.push(inner + a, outer + next, inner + next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

// A thin curved annulus between innerRadius and outerRadius — the same
// per-vertex curvedPosition treatment as buildCurvedDiscGeometry, just two
// rings with no center fan (this map's world-boundary line never reaches
// r=0). ringCount lets a wide band (unused here, innerRadius/outerRadius
// are close together for this map's own thin boundary line) still curve
// smoothly instead of interpolating flat between just two curved rings.
function buildCurvedRingBand(innerRadius, outerRadius, ringCount, angularSegments) {
  const positions = [];
  const ringStart = [];
  for (let ring = 0; ring <= ringCount; ring++) {
    ringStart[ring] = positions.length / 3;
    const r = innerRadius + ((outerRadius - innerRadius) * ring) / ringCount;
    for (let a = 0; a < angularSegments; a++) {
      const theta = (a / angularSegments) * Math.PI * 2;
      const point = curvedPosition({ x: r * Math.cos(theta), y: r * Math.sin(theta), z: 0 });
      positions.push(point.x, point.y, point.z);
    }
  }
  const indices = [];
  for (let ring = 0; ring < ringCount; ring++) {
    const inner = ringStart[ring];
    const outer = ringStart[ring + 1];
    for (let a = 0; a < angularSegments; a++) {
      const next = (a + 1) % angularSegments;
      indices.push(inner + a, outer + a, outer + next);
      indices.push(inner + a, outer + next, inner + next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

// A navigable overhead flyover: an orbit-controlled camera looking down at
// a curved rendering (see buildCurvedDiscGeometry above) of the whole world
// circle and every landlet in it, each shape/position/color drawn straight
// from real world data (no separate 2D projection math — a landlet's plot
// sits at its own center_x_m/center_y_m, run through curvedPosition, on
// the same ground the builder scene itself uses). Tapping a plot previews
// it below regardless of status; only an available (greenbelt) one enables
// the Claim button.
async function loadLandletMap(resolve) {
  const myLoadToken = ++claimMapLoadToken;
  claimStatusEl.textContent = 'Loading the world…';
  claimStatusEl.classList.remove('error');
  claimSelectionNameEl.textContent = 'No plot selected';
  claimConfirmBtn.disabled = true;
  claimConfirmBtn.onclick = null;
  disposeClaimFlyover();

  let world;
  let landlets;
  try {
    // Landlets still generating (not yet enclosed by the world's expansion
    // radius) are queued backend state, not something to show a builder —
    // only fetch the two statuses that are meaningful to see/select here.
    // #885: fetchLandlets only ever returns one page — GET /api/landlets
    // orders oldest-first, so a plain limit:100 here would permanently cap
    // this map at the oldest 100 greenbelt/claimed landlets ever generated,
    // silently hiding every plot from the ongoing world-expansion pipeline
    // (same bug class #186/#190 already fixed for other /landlets callers).
    // fetchAllLandlets follows nextCursor to get the real full set.
    const [fetchedWorld, greenbeltLandlets, claimedLandlets] = await Promise.all([
      fetchWorld(),
      fetchAllLandlets({ status: 'greenbelt' }),
      fetchAllLandlets({ status: 'claimed' }),
    ]);
    world = fetchedWorld;
    landlets = [...greenbeltLandlets, ...claimedLandlets];
  } catch (err) {
    if (myLoadToken !== claimMapLoadToken) return; // superseded — a newer load owns the UI now
    claimStatusEl.textContent = err.message || 'Could not load the world.';
    claimStatusEl.classList.add('error');
    return;
  }
  if (myLoadToken !== claimMapLoadToken) return; // superseded while fetching — abandon quietly, nothing built yet

  const radiusM = world.radiusM;
  const scene = new THREE.Scene();
  // Bright pale sky + soft green ground — this map used to be a near-black
  // "radar" backdrop, which read as ominous rather than the lighthearted,
  // bright feel the rest of the world now goes for (see the day-night
  // removal and index.html's own brand-color comment).
  scene.background = new THREE.Color(0x87ceeb);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(radiusM, -radiusM, radiusM * 2);
  scene.add(sun);

  const ground = new THREE.Mesh(
    buildCurvedDiscGeometry(radiusM * 1.4, 16, 64),
    new THREE.MeshBasicMaterial({ color: 0xa8d98a }),
  );
  scene.add(ground);

  const boundary = new THREE.Mesh(
    buildCurvedRingBand(radiusM * 0.99, radiusM * 1.01, 2, 128),
    new THREE.MeshBasicMaterial({ color: 0x16240a, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  );
  boundary.position.z = 0.02;
  scene.add(boundary);

  // Plots of the same status share a fill color, so without a per-plot
  // border two adjacent greenbelt lands would visually merge into one —
  // this is a placeholder selection UI (a real flyover will eventually
  // replace it), so making individual land boundaries readable at a glance
  // matters more here than it would in a polished final view.
  const plotOutlineMaterial = new THREE.LineBasicMaterial({ color: 0x0d1a08, transparent: true, opacity: 0.7 });
  const plotMeshes = [];
  const plotOutlines = [];
  let anyAvailable = false;
  for (const landlet of landlets) {
    if (landlet.status === 'greenbelt' && landlet.landType !== 'water') anyAvailable = true;
    const shape = shapeForLandlet(landlet);
    const geometry = new THREE.ShapeGeometry(shape);
    const material = new THREE.MeshBasicMaterial({ color: CLAIM_PLOT_COLORS[plotColorKeyForLandlet(landlet)] ?? 0xffffff });
    const mesh = new THREE.Mesh(geometry, material);
    // The plot's own polygon (shape, above) stays flat — only its
    // placement moves to the real curved position. Tilting the polygon
    // itself to lie tangent to the curve would be more "correct," but at
    // one landlet's own ~31.6m span the tilt is imperceptible (the same
    // reasoning this map's own ground curve comment gives), so it's left
    // flat rather than adding a tangent-plane rotation with no visible
    // payoff yet.
    const curvedCenter = curvedPosition({ x: landlet.center.x, y: landlet.center.y, z: 0 });
    mesh.position.set(curvedCenter.x, curvedCenter.y, curvedCenter.z + 0.05);
    mesh.userData.landlet = landlet;
    scene.add(mesh);
    plotMeshes.push(mesh);

    const outlineGeometry = new THREE.BufferGeometry().setFromPoints(
      shape.getPoints().map((p) => new THREE.Vector3(p.x, p.y, 0)),
    );
    const outline = new THREE.LineLoop(outlineGeometry, plotOutlineMaterial);
    outline.position.set(curvedCenter.x, curvedCenter.y, curvedCenter.z + 0.06);
    scene.add(outline);
    plotOutlines.push(outline);
  }

  // A dedicated outline per selection, built from the same polygon as the
  // plot itself (not a bounding box, which reads as a plain rectangle for
  // every non-square shape) — swapped out on each click the same way
  // applyLandletShape() swaps the main builder scene's ground geometry. A
  // bold yellow ring (the brand's secondary pale-yellow hue, saturated up
  // for a "this one's selected" highlight) rather than white, which would
  // barely register against this map's now-bright ground colors.
  const selectionOutlineMaterial = new THREE.LineBasicMaterial({ color: 0xf5c518 });
  let selectionOutline = null;
  let selectedMesh = null;

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, radiusM * 20);
  camera.up.set(0, 0, 1); // Z-up, matching the builder scene's own convention
  camera.position.set(0, -radiusM * 1.8, radiusM * 1.6);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas: claimMapCanvas, antialias: true });
  const controls = new OrbitControls(camera, claimMapCanvas);
  controls.target.set(0, 0, 0);
  controls.minDistance = radiusM * 0.15;
  controls.maxDistance = radiusM * 6;
  controls.maxPolarAngle = Math.PI * 0.49; // stop just shy of edge-on/underground
  controls.update();

  function onResize() {
    const rect = claimMapCanvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  }
  onResize();
  window.addEventListener('resize', onResize);

  const raycaster = new THREE.Raycaster();
  const pointerNdcClaim = new THREE.Vector2();
  // Named (rather than an inline arrow passed straight to addEventListener)
  // so disposeClaimFlyover above can remove this exact function later —
  // see its own comment on why that matters (#1131).
  function onCanvasClick(event) {
    const rect = claimMapCanvas.getBoundingClientRect();
    pointerNdcClaim.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdcClaim.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdcClaim, camera);
    const hits = raycaster.intersectObjects(plotMeshes);
    if (hits.length === 0) return;
    const mesh = hits[0].object;
    const landlet = mesh.userData.landlet;

    if (selectedMesh) {
      selectedMesh.material.color.setHex(CLAIM_PLOT_COLORS[plotColorKeyForLandlet(selectedMesh.userData.landlet)] ?? 0xffffff);
    }
    selectedMesh = mesh;
    // Lighten toward white rather than using a fixed highlight color, so
    // the highlighted plot still visibly carries its own status color
    // (available vs. claimed vs. water) instead of every selection looking
    // the same.
    mesh.material.color.setHex(CLAIM_PLOT_COLORS[plotColorKeyForLandlet(landlet)] ?? 0xffffff).lerp(new THREE.Color(0xffffff), 0.45);

    if (selectionOutline) {
      scene.remove(selectionOutline);
      selectionOutline.geometry.dispose();
    }
    const outlinePoints = shapeForLandlet(landlet).getPoints().map((p) => new THREE.Vector3(p.x, p.y, 0));
    selectionOutline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(outlinePoints), selectionOutlineMaterial);
    const curvedSelectionCenter = curvedPosition({ x: landlet.center.x, y: landlet.center.y, z: 0 });
    selectionOutline.position.set(curvedSelectionCenter.x, curvedSelectionCenter.y, curvedSelectionCenter.z + 0.07);
    selectionOutline.renderOrder = 2;
    scene.add(selectionOutline);
    claimFlyover.selectionOutline = selectionOutline;

    const statusLabel = landlet.landType === 'water' ? 'Water' : landlet.status === 'greenbelt' ? 'Available' : 'Claimed';
    claimSelectionNameEl.textContent = `${landlet.name} (${formatArea(landlet.areaM2)}) — ${statusLabel}`;
    claimConfirmBtn.disabled = landlet.status !== 'greenbelt' || landlet.landType === 'water';
    claimConfirmBtn.onclick = () => claimSelectedLandlet(landlet, resolve);
  }
  claimMapCanvas.addEventListener('click', onCanvasClick);

  function animate() {
    claimFlyover.animationHandle = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  claimFlyover = {
    scene, camera, renderer, controls, plotMeshes, plotOutlines, plotOutlineMaterial, onResize, onCanvasClick, animationHandle: 0,
    selectionOutline: null, selectionOutlineMaterial,
  };
  animate();

  // The world now grows itself on a schedule (see worker/index.js's
  // scheduled() export) rather than needing a player to trigger it by
  // hand — this can only actually show right after a fresh deployment, in
  // the brief window before the first automatic growth cycle runs.
  claimStatusEl.textContent = anyAvailable
    ? ''
    : 'No lándlets are ready to claim yet — check back again shortly.';
}

async function claimSelectedLandlet(landlet, resolve) {
  claimConfirmBtn.disabled = true;
  claimStatusEl.textContent = `Claiming ${landlet.name}…`;
  claimStatusEl.classList.remove('error');
  try {
    const claimed = await claimLandlet(landlet.landletId);
    disposeClaimFlyover();
    claimModalEl.classList.remove('visible');
    closeModalA11y(claimModalEl);
    resolve(claimed.landletId);
  } catch (err) {
    // Someone else likely claimed it in the meantime (409) — refresh the
    // map since its status is now stale.
    claimStatusEl.textContent = err.message || 'Claim failed — it may have just been taken.';
    claimStatusEl.classList.add('error');
    loadLandletMap(resolve);
  }
}
