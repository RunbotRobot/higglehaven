const DEFAULT_ITERATIONS = 600;

// Builds one finite, equal-area power diagram. Curves are sampled from each
// shared straight seam with an S-bend whose signed area is zero, so neighboring
// polygons stay complementary without changing their target areas.
export function generateOrganicMosaic({ prefix, count, seed = prefix, areaM2 = 1000 }) {
  const side = Math.sqrt(count * areaM2);
  const random = seededRandom(seed);
  const sites = blueNoiseSites(count, side, random);
  const weights = Array(count).fill(0);
  let cells;
  for (let iteration = 0; iteration < DEFAULT_ITERATIONS; iteration += 1) {
    cells = powerCells(sites, weights, side);
    const gain = 0.55 * (1 - iteration / (DEFAULT_ITERATIONS * 1.2));
    cells.forEach((cell, index) => { weights[index] += gain * (areaM2 - polygonArea(cell)); });
  }
  cells = powerCells(sites, weights, side);
  const edgeCurves = sharedEdgeCurves(cells, seed);

  return cells.map((cell, index) => {
    const worldPolygon = curvedCell(cell, edgeCurves).map(({ x, y }) => ({ x: x - side / 2, y: y - side / 2 }));
    const center = polygonCentroid(worldPolygon);
    return {
      landletId: `${prefix}-${String(index + 1).padStart(3, '0')}`,
      name: `${prefix} ${index + 1}`,
      areaM2,
      center,
      landClass: 1,
      polygon: worldPolygon.map(({ x, y }) => ({ x: x - center.x, y: y - center.y })),
      metadata: { generated: true, generator: 'organic-mosaic-v1', mosaicIndex: index, seed },
    };
  });
}

function blueNoiseSites(count, side, random) {
  const sites = [];
  const minimum = side / Math.sqrt(count) * 0.52;
  for (let attempt = 0; sites.length < count && attempt < count * 2000; attempt += 1) {
    const candidate = { x: random() * side, y: random() * side };
    if (sites.every((site) => Math.hypot(site.x - candidate.x, site.y - candidate.y) >= minimum)) {
      sites.push(candidate);
    }
  }
  while (sites.length < count) sites.push({ x: random() * side, y: random() * side });
  return sites;
}

function powerCells(sites, weights, side) {
  return sites.map((site, index) => {
    let polygon = [{ x: 0, y: 0 }, { x: side, y: 0 }, { x: side, y: side }, { x: 0, y: side }];
    sites.forEach((other, otherIndex) => {
      if (index === otherIndex || polygon.length === 0) return;
      const a = 2 * (other.x - site.x);
      const b = 2 * (other.y - site.y);
      const c = other.x ** 2 + other.y ** 2 - site.x ** 2 - site.y ** 2
        + weights[index] - weights[otherIndex];
      polygon = clipHalfPlane(polygon, a, b, c);
    });
    return polygon;
  });
}

function clipHalfPlane(polygon, a, b, c) {
  const output = [];
  polygon.forEach((start, index) => {
    const end = polygon[(index + 1) % polygon.length];
    const startValue = a * start.x + b * start.y - c;
    const endValue = a * end.x + b * end.y - c;
    if (startValue <= 1e-8) output.push(start);
    if ((startValue <= 1e-8) !== (endValue <= 1e-8)) {
      const t = startValue / (startValue - endValue);
      output.push({ x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) });
    }
  });
  return output;
}

function sharedEdgeCurves(cells, seed) {
  const curves = new Map();
  cells.forEach((cell) => cell.forEach((start, index) => {
    const end = cell[(index + 1) % cell.length];
    const key = edgeKey(start, end);
    if (curves.has(key)) return;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const bend = (seededRandom(`${seed}:${key}`)() - 0.5) * Math.min(8, length * 0.24);
    const points = Array.from({ length: 5 }, (_, step) => {
      const t = step / 4;
      const offset = bend * Math.sin(Math.PI * 2 * t);
      return { x: start.x + dx * t - (dy / length) * offset, y: start.y + dy * t + (dx / length) * offset };
    });
    curves.set(key, { start: pointKey(start), points });
  }));
  return curves;
}

function curvedCell(cell, curves) {
  const result = [];
  cell.forEach((start, index) => {
    const end = cell[(index + 1) % cell.length];
    const curve = curves.get(edgeKey(start, end));
    const points = curve.start === pointKey(start) ? curve.points : [...curve.points].reverse();
    result.push(...points.slice(0, -1));
  });
  return result;
}

function edgeKey(a, b) { return [pointKey(a), pointKey(b)].sort().join('|'); }
function pointKey(point) { return `${point.x.toFixed(7)},${point.y.toFixed(7)}`; }

function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function polygonCentroid(points) {
  let crossSum = 0; let xSum = 0; let ySum = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    const cross = point.x * next.y - next.x * point.y;
    crossSum += cross; xSum += (point.x + next.x) * cross; ySum += (point.y + next.y) * cross;
  });
  return { x: xSum / (3 * crossSum), y: ySum / (3 * crossSum) };
}

function seededRandom(seed) {
  let state = 2166136261;
  for (const character of seed) { state ^= character.codePointAt(0); state = Math.imul(state, 16777619); }
  return () => {
    state += 0x6d2b79f5; let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
