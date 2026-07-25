import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Naming convention (see docs/SPEC.md): plain "a" internally — "landlet", not "lándlet".
// A standard landlet is exactly 1000 m^2. Square footprint for this first pass:
// side length = sqrt(area), giving an edge just over 31.6 meters.
const LANDLET_AREA_M2 = 1000;
const LANDLET_SIDE_M = Math.sqrt(LANDLET_AREA_M2);

const canvas = document.getElementById('app');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // flat placeholder sky color

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
// Positioned up and back so the whole plot is in frame; Three.js is Y-up.
camera.position.set(LANDLET_SIDE_M * 0.6, LANDLET_SIDE_M * 0.5, LANDLET_SIDE_M * 0.6);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

// Dev-only orbit camera so the scene is inspectable on a phone (pinch/drag)
// before any real avatar movement exists. Not part of the in-world control scheme.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(20, 30, 10);
scene.add(sunLight);

// PlaneGeometry is built flat in the XY plane by default; rotating -90 deg
// around X lays it down onto the XZ ground plane (Y = up).
const landletGeometry = new THREE.PlaneGeometry(LANDLET_SIDE_M, LANDLET_SIDE_M);
const landletMaterial = new THREE.MeshStandardMaterial({ color: 0x4caf50 }); // placeholder grass
const landlet = new THREE.Mesh(landletGeometry, landletMaterial);
landlet.rotation.x = -Math.PI / 2;
scene.add(landlet);

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
