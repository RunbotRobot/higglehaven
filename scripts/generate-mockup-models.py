#!/usr/bin/env python3
"""Generates public/models/*.glb — simple procedural placeholder models made
of primitive shapes (trimesh), the same style as the existing crate/planter/
lamp/table/brick/chair/tree models (see git log for
"Replace box placeholders with real glTF product models").

Authored in plain Y-up space, matching every other model here — main.js's
own model-loading pipeline applies the standard Y-up -> Z-up correction, so
these deliberately aren't pre-rotated to dodge that (see that commit's own
comment on why: it's meant to exercise the same pipeline a real seller-
uploaded model would go through, not a shortcut).

trimesh.creation.cylinder()/cone() default to a Z-axis, not Y — every
part below that isn't a plain box gets rotated 90 degrees about X to stand
it upright in this file's Y-up convention, the same fix noted in that
commit's own message.

Usage:
    pip install trimesh numpy
    python3 scripts/generate-mockup-models.py
"""
import os

import numpy as np
import trimesh

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'public', 'models')

# Standing a Z-axis primitive upright along Y.
ROTATE_Z_TO_Y = trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])


def box(extents, translation, color):
    mesh = trimesh.creation.box(extents=extents)
    mesh.apply_translation(translation)
    mesh.visual = trimesh.visual.TextureVisuals(
        material=trimesh.visual.material.PBRMaterial(baseColorFactor=[*color, 255]),
    )
    return mesh


def cylinder(radius, height, translation, color, sections=16):
    mesh = trimesh.creation.cylinder(radius=radius, height=height, sections=sections)
    mesh.apply_transform(ROTATE_Z_TO_Y)
    mesh.apply_translation(translation)
    mesh.visual = trimesh.visual.TextureVisuals(
        material=trimesh.visual.material.PBRMaterial(baseColorFactor=[*color, 255]),
    )
    return mesh


def scene_of(parts_by_name):
    scene = trimesh.Scene()
    for name, mesh in parts_by_name.items():
        scene.add_geometry(mesh, node_name=name, geom_name=name)
    return scene


def export(name, scene):
    path = os.path.join(OUT_DIR, f'{name}.glb')
    scene.export(path)
    print(f'wrote {path}')


# ---- Picket Fence Panel (building-materials) — width 1.2, height ~1.1 ----
# Two corner posts, top/bottom rails between them, and pickets across the
# gap — placed edge-to-edge like brick, it builds a fence line the same
# repeatable way brick builds a wall.
POST_WOOD = (120, 92, 61)
PICKET_WOOD = (163, 133, 97)
fence_parts = {}
for i, sign in enumerate([-1, 1]):
    fence_parts[f'post_{i}'] = box([0.08, 1.1, 0.08], [sign * 0.56, 0, 0], POST_WOOD)
for i, y in enumerate([0.75, 0.25]):
    fence_parts[f'rail_{i}'] = box([1.2, 0.06, 0.03], [0, y, 0], POST_WOOD)
n_pickets = 7
for i in range(n_pickets):
    x = -0.5 + i * (1.0 / (n_pickets - 1))
    fence_parts[f'picket_{i}'] = box([0.09, 0.9, 0.02], [x, 0.05, 0.045], PICKET_WOOD)
export('fence', scene_of(fence_parts))

# ---- Garden Bench (furniture/seating) — width 1.2, depth 0.5, height 0.85 ----
BENCH_WOOD = (74, 103, 65)  # painted garden-bench green
bench_parts = {
    'seat': box([1.2, 0.05, 0.5], [0, 0.45, 0], BENCH_WOOD),
    'backrest': box([1.2, 0.4, 0.05], [0, 0.65, -0.225], BENCH_WOOD),
}
for i, (sx, sz) in enumerate([(-1, -1), (-1, 1), (1, -1), (1, 1)]):
    bench_parts[f'leg_{i}'] = box(
        [0.05, 0.45, 0.05],
        [sx * 0.55, 0.225, sz * 0.2],
        BENCH_WOOD,
    )
export('bench', scene_of(bench_parts))

# ---- Mailbox (garden) — width 0.2, depth 0.35, height 1.2 ----
MAILBOX_POST = (90, 74, 58)
MAILBOX_BODY = (150, 32, 32)
MAILBOX_FLAG = (200, 200, 60)
mailbox_parts = {
    'post': cylinder(0.03, 1.0, [0, 0.5, 0], MAILBOX_POST),
    'box': box([0.2, 0.22, 0.35], [0, 1.1, 0], MAILBOX_BODY),
    'flag': box([0.02, 0.12, 0.02], [0.08, 1.15, 0.19], MAILBOX_FLAG),
}
export('mailbox', scene_of(mailbox_parts))

# ---- Bookshelf (furniture/storage) — width 0.9, depth 0.3, height 1.8 ----
SHELF_WOOD = (101, 67, 33)
SHELF_ACCENT = (130, 90, 50)
bookshelf_parts = {
    'left_side': box([0.05, 1.8, 0.3], [-0.425, 0.9, 0], SHELF_WOOD),
    'right_side': box([0.05, 1.8, 0.3], [0.425, 0.9, 0], SHELF_WOOD),
    'top': box([0.9, 0.05, 0.3], [0, 1.775, 0], SHELF_WOOD),
    'bottom': box([0.9, 0.05, 0.3], [0, 0.025, 0], SHELF_WOOD),
    'back': box([0.9, 1.8, 0.02], [0, 0.9, -0.14], SHELF_WOOD),
}
for i, y in enumerate([0.5, 0.95, 1.4]):
    bookshelf_parts[f'shelf_{i}'] = box([0.82, 0.03, 0.28], [0, y, 0], SHELF_ACCENT)
export('bookshelf', scene_of(bookshelf_parts))

# ---- Rug (flooring) — width 2.0, depth 1.4, height 0.02 (flat, like brick) ----
RUG_COLOR = (176, 58, 46)
rug_parts = {
    'rug': box([2.0, 0.02, 1.4], [0, 0.01, 0], RUG_COLOR),
}
export('rug', scene_of(rug_parts))
