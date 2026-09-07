#!/usr/bin/env node
// Real-world terrain/hydrology ingestion for higglehaven's macro-geography
// (#219, sub-issue of #206). Builds the "pre-human natural geology"
// dataset docs/SPEC.md §1 asks for around the world's real-world anchor
// point (#138 — WORLD_ORIGIN_LATITUDE/LONGITUDE in worker/earthCurvature.js):
// which points, in this world's own flat (x, y) meters, should be treated
// as water once the Lake Washington Ship Canal's 1916 lowering (and the
// Montlake Cut it required) are corrected away — see worker/geoData.js's
// classifyPreHumanWaterType for the actual rule and its sourcing.
//
// Data sources (both public, unauthenticated, live-tested against the real
// services while writing this script):
//   - USGS 3DEP Elevation Point Query Service (epqs.nationalmap.gov) for
//     real ground elevation at a point.
//   - USGS National Hydrography Dataset, "Waterbody - Large Scale" layer,
//     via the National Map's ArcGIS REST service, for today's actual Lake
//     Washington/Lake Union polygons (the floor this correction builds up
//     from — the lake only ever shrank in 1916, never grew, so today's
//     water was certainly water before too).
//
// Not attempted here (explicitly out of scope per #219's own text): writing
// results into the landlets table (#218's data model) or wiring this into
// actual landlet generation — this only produces the dataset a future
// generation step can consult. Re-run this offline as the world's radius
// grows (matching docs/SPEC.md §37's own "regenerated offline on major
// changes" LOD-backdrop convention) rather than fetching live per-request.
//
// Usage:
//   node scripts/ingest-geo-data.mjs [--radius=2000] [--spacing=25] [--out=data/geo/pre-human-water-cells.json]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPreHumanWaterType,
  distanceToPolygonM,
  latLonToWorld,
  pointInPolygon,
  worldToLatLon,
} from '../worker/geoData.js';
import { WORLD_ORIGIN_LATITUDE, WORLD_ORIGIN_LONGITUDE } from '../worker/earthCurvature.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? Number(arg.slice(prefix.length)) : fallback;
}

const RADIUS_M = parseArg('radius', 2000); // how far from the world origin to sample
const SPACING_M = parseArg('spacing', 25); // grid spacing between sample points
const RECLAMATION_RADIUS_M = parseArg('reclamation-radius', 400); // see geoData.js's classifyPreHumanWaterType doc
const OUT_PATH = (process.argv.find((a) => a.startsWith('--out=')) || '--out=data/geo/pre-human-water-cells.json').slice('--out='.length);

const NHD_WATERBODY_URL = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query';
const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json';

// A small pause between elevation requests — this is a shared public
// service with no API key, so this script deliberately serializes its
// requests rather than firing RADIUS_M/SPACING_M-squared of them at once.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCurrentWaterbodyPolygons({ originLat, originLon, radiusM }) {
  // A crude degrees-per-meter pad around the origin, generous enough at
  // this app's regional scale (a few km at most) that it never clips a
  // waterbody polygon straddling the edge of the query box.
  const padDeg = (radiusM / 111000) * 1.5;
  const bbox = [originLon - padDeg, originLat - padDeg, originLon + padDeg, originLat + padDeg].join(',');
  const url = `${NHD_WATERBODY_URL}?geometry=${encodeURIComponent(bbox)}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=gnis_name,ftype&returnGeometry=true&outSR=4326&f=geojson`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`NHD waterbody query failed: ${response.status}`);
  const geojson = await response.json();
  const polygons = [];
  for (const feature of geojson.features || []) {
    if (feature.geometry?.type !== 'Polygon') continue;
    // First ring only (the outer boundary) — this dataset's lake/pond
    // polygons in this region don't carry islands large enough to matter
    // at higglehaven's own "lower fidelity bar" (docs/SPEC.md §8).
    const ring = feature.geometry.coordinates[0];
    polygons.push(ring.map(([lon, lat]) => latLonToWorld(lat, lon, { originLat, originLon })));
  }
  return polygons;
}

// EPQS is a free, unauthenticated public service and occasionally returns a
// truncated/empty body or a transient 5xx under load — retried a few times
// with backoff before giving up on this one point, rather than crashing the
// whole (potentially long-running) grid.
async function fetchElevationM(lat, lon, attempts = 3) {
  const url = `${EPQS_URL}?x=${lon}&y=${lat}&units=Meters&wkid=4326&includeDate=false`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`EPQS query failed: ${response.status}`);
      const text = await response.text();
      const data = JSON.parse(text);
      const value = Number(data.value);
      if (!Number.isFinite(value)) throw new Error(`EPQS returned a non-numeric elevation: ${data.value}`);
      return value;
    } catch (err) {
      if (attempt === attempts) throw err;
      await sleep(500 * attempt);
    }
  }
  throw new Error('unreachable');
}

function classifyAgainstPolygons(point, polygons) {
  let inCurrentWaterbody = false;
  let distanceToShorelineM = Infinity;
  for (const polygon of polygons) {
    if (pointInPolygon(point, polygon)) {
      inCurrentWaterbody = true;
      distanceToShorelineM = 0;
      break;
    }
    distanceToShorelineM = Math.min(distanceToShorelineM, distanceToPolygonM(point, polygon));
  }
  return { inCurrentWaterbody, distanceToShorelineM };
}

async function main() {
  console.log(
    `Ingesting geo data: radius=${RADIUS_M}m spacing=${SPACING_M}m reclamationRadius=${RECLAMATION_RADIUS_M}m around (${WORLD_ORIGIN_LATITUDE}, ${WORLD_ORIGIN_LONGITUDE})`
  );

  const polygons = await fetchCurrentWaterbodyPolygons({
    originLat: WORLD_ORIGIN_LATITUDE,
    originLon: WORLD_ORIGIN_LONGITUDE,
    radiusM: RADIUS_M,
  });
  console.log(`Fetched ${polygons.length} current waterbody polygon(s) from NHD.`);

  const cells = [];
  let elevationFetches = 0;
  for (let x = -RADIUS_M; x <= RADIUS_M; x += SPACING_M) {
    for (let y = -RADIUS_M; y <= RADIUS_M; y += SPACING_M) {
      if (Math.hypot(x, y) > RADIUS_M) continue;
      const point = { x, y };
      const { inCurrentWaterbody, distanceToShorelineM } = classifyAgainstPolygons(point, polygons);

      let elevationM = null;
      // Only spend a live elevation request where it can actually change
      // the outcome: already-underwater points are 'water' regardless, and
      // points well outside the reclamation radius are 'buildable'
      // regardless (see classifyPreHumanWaterType's own doc comment).
      if (!inCurrentWaterbody && distanceToShorelineM <= RECLAMATION_RADIUS_M) {
        const { lat, lon } = worldToLatLon(x, y, { originLat: WORLD_ORIGIN_LATITUDE, originLon: WORLD_ORIGIN_LONGITUDE });
        try {
          elevationM = await fetchElevationM(lat, lon);
          elevationFetches += 1;
        } catch (err) {
          // Elevation genuinely unknown for this point after retries — stay
          // conservative (never fabricate a 'water' classification we
          // can't actually back with real data) and just leave it
          // 'buildable', logging so a re-run can be targeted at the gap.
          console.warn(`Elevation lookup failed for (${lat}, ${lon}), leaving buildable: ${err.message}`);
        }
        await sleep(150);
      }

      const landType = classifyPreHumanWaterType({
        elevationM: elevationM ?? Infinity,
        inCurrentWaterbody,
        distanceToShorelineM,
        reclamationRadiusM: RECLAMATION_RADIUS_M,
      });
      if (landType === 'water') cells.push({ x, y, landType });
    }
    if (elevationFetches > 0) console.log(`  ...row x=${x}: ${elevationFetches} elevation lookup(s) so far, ${cells.length} water cell(s) so far`);
  }

  console.log(`Classified grid: ${cells.length} water cell(s), ${elevationFetches} live elevation lookup(s).`);

  const output = {
    generatedAt: new Date().toISOString(),
    originLat: WORLD_ORIGIN_LATITUDE,
    originLon: WORLD_ORIGIN_LONGITUDE,
    radiusM: RADIUS_M,
    spacingM: SPACING_M,
    reclamationRadiusM: RECLAMATION_RADIUS_M,
    // Sparse format: only water cells are listed (buildable is the default
    // for a landlet whose footprint doesn't overlap one) — a future
    // landlet-generation consumer (#218's land_type column already exists)
    // checks whether a candidate landlet's polygon/center falls near one of
    // these points before deciding land_type; not wired into generation by
    // this script.
    cells,
  };

  const outPath = path.isAbsolute(OUT_PATH) ? OUT_PATH : path.join(repoRoot, OUT_PATH);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
