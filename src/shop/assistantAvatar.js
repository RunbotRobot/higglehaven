// #3445 (part of #3444): the look of a fleet assistant in the Shop world: the
// collared "higglehaven" shirt (docs/SPEC.md §6, "Runbot's role") and a tag
// with its name and the word "assistant" above its head. Both hang off the
// avatar's stable outer group, so a body swap never loses them.
//
// No shirt asset existed, so this is the simplest one that reads at phone
// size: a cream shirt a little wider than the torso, a collar ring at the
// neck, and a green "h" chest patch in the brand colour.
import * as THREE from 'three';
import {
  SHOP_AVATAR_LEG_LENGTH_M, SHOP_AVATAR_TORSO_LENGTH_M, SHOP_AVATAR_TORSO_RADIUS_M,
  SHOP_AVATAR_HEAD_RADIUS_M,
} from '../main.js';
import { assistantNameFrom, assistantTagLines } from './assistantLabel.js';

const SHIRT_COLOR = 0xf4f1ea;
const PATCH_COLOR = 0x3f8f5a;
const TAG_HEIGHT_ABOVE_HEAD_M = 0.3;
const TAG_WORLD_UNITS_PER_PX = 0.006;

function createAssistantShirt() {
  const group = new THREE.Group();
  group.name = 'assistant-shirt';
  const shirtMaterial = new THREE.MeshStandardMaterial({ color: SHIRT_COLOR });
  const torsoCenterZ = SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M / 2 + SHOP_AVATAR_TORSO_RADIUS_M;
  const shirt = new THREE.Mesh(
    new THREE.CapsuleGeometry(SHOP_AVATAR_TORSO_RADIUS_M * 1.12, SHOP_AVATAR_TORSO_LENGTH_M * 0.9, 4, 12),
    shirtMaterial,
  );
  shirt.rotation.x = Math.PI / 2; // stand the capsule's local-Y axis up along Z, as the body's torso does
  shirt.position.z = torsoCenterZ;
  group.add(shirt);

  const neckZ = SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_TORSO_RADIUS_M * 1.85;
  const collar = new THREE.Mesh(new THREE.TorusGeometry(SHOP_AVATAR_TORSO_RADIUS_M * 0.9, 0.035, 8, 20), shirtMaterial);
  collar.position.z = neckZ; // a torus lies in the XY plane, which is horizontal here
  group.add(collar);

  // The avatar's front is +Y (see createShopAvatar's face comment).
  const patch = new THREE.Mesh(
    new THREE.CircleGeometry(SHOP_AVATAR_TORSO_RADIUS_M * 0.32, 14),
    new THREE.MeshBasicMaterial({ color: PATCH_COLOR, side: THREE.DoubleSide }),
  );
  patch.rotation.x = -Math.PI / 2;
  patch.position.set(SHOP_AVATAR_TORSO_RADIUS_M * 0.4, SHOP_AVATAR_TORSO_RADIUS_M * 1.13, torsoCenterZ + SHOP_AVATAR_TORSO_LENGTH_M * 0.2);
  group.add(patch);
  return group;
}

function createAssistantTag(name) {
  const [nameLine, wordLine] = assistantTagLines(name);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const nameFont = '600 44px sans-serif';
  const wordFont = '30px sans-serif';
  ctx.font = nameFont;
  const nameWidth = ctx.measureText(nameLine).width;
  ctx.font = wordFont;
  const wordWidth = ctx.measureText(wordLine).width;
  const paddingX = 24;
  canvas.width = Math.ceil(Math.max(nameWidth, wordWidth)) + paddingX * 2;
  canvas.height = 96;
  // Sizing the canvas resets its context, so the fonts are set again.
  ctx.fillStyle = 'rgba(20, 24, 18, 0.82)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f5f5f0';
  ctx.font = nameFont;
  ctx.fillText(nameLine, canvas.width / 2, 36);
  ctx.fillStyle = '#9fd7b0';
  ctx.font = wordFont;
  ctx.fillText(wordLine, canvas.width / 2, 74);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.name = 'assistant-tag';
  sprite.scale.set(canvas.width * TAG_WORLD_UNITS_PER_PX, canvas.height * TAG_WORLD_UNITS_PER_PX, 1);
  sprite.position.z = SHOP_AVATAR_LEG_LENGTH_M + SHOP_AVATAR_TORSO_LENGTH_M + SHOP_AVATAR_TORSO_RADIUS_M * 2
    + SHOP_AVATAR_HEAD_RADIUS_M * 2 + TAG_HEIGHT_ABOVE_HEAD_M;
  return sprite;
}

function removeLook(entry) {
  for (const key of ['assistantShirt', 'assistantTag']) {
    const part = entry[key];
    if (!part) continue;
    entry.group.remove(part);
    part.traverse((child) => {
      child.geometry?.dispose();
      if (child.material) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    });
    entry[key] = null;
  }
  entry.assistantName = null;
}

// Brings an other-avatar entry in line with what the latest poll said about it:
// dresses it as an assistant (or re-names it), or takes the look off.
export function applyAssistantLook(entry, rawAssistant) {
  const name = assistantNameFrom(rawAssistant);
  if (name === (entry.assistantName ?? null)) return;
  removeLook(entry);
  if (!name) return;
  entry.assistantName = name;
  entry.assistantShirt = createAssistantShirt();
  entry.assistantTag = createAssistantTag(name);
  entry.group.add(entry.assistantShirt, entry.assistantTag);
}
