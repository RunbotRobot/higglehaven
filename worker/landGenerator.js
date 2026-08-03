const TAU = Math.PI * 2;

// Produces a complete, gap-free annular band. Each plot shares its radial
// edges and sampled circular edges with its neighbours, so the output can be
// queued directly without relying on a grid or post-generation snapping.
export function generateLandletRing({ prefix, count, innerRadiusM, startAngleRad = 0, areaM2 = 1000, plots }) {
  const arcSegments = 4;
  const definitions = plots || Array.from({ length: count }, () => ({ areaM2, landClass: 1 }));
  const areaScale = ringAreaScale(definitions.map((plot) => plot.areaM2), arcSegments);
  const angles = definitions.map((plot) => arcSegments * Math.asin(plot.areaM2 / (areaScale * arcSegments)));
  const outerRadiusM = Math.sqrt(innerRadiusM ** 2 + 2 * areaScale);
  const normalizedStart = ((startAngleRad % TAU) + TAU) % TAU;
  const boundarySignature = JSON.stringify([
    Number(normalizedStart.toPrecision(15)),
    ...angles.map((angle) => Number(angle.toPrecision(15))),
  ]);
  let nextAngle = startAngleRad;

  const landlets = definitions.map((definition, index) => {
    const angle = angles[index];
    const start = nextAngle;
    nextAngle += angle;
    const worldPolygon = [];
    for (let step = 0; step <= arcSegments; step += 1) {
      worldPolygon.push(polar(outerRadiusM, start + (angle * step) / arcSegments));
    }
    for (let step = arcSegments; step >= 0; step -= 1) {
      worldPolygon.push(polar(innerRadiusM, start + (angle * step) / arcSegments));
    }
    const center = polygonCentroid(worldPolygon);
    return {
      landletId: `${prefix}-${String(index + 1).padStart(3, '0')}`,
      name: `${prefix} ${index + 1}`,
      areaM2: definition.areaM2,
      center,
      landClass: definition.landClass,
      polygon: worldPolygon.map((point) => ({ x: point.x - center.x, y: point.y - center.y })),
      metadata: { generated: true, generator: 'annular-ring-v1', ringIndex: index, ...definition.metadata },
    };
  });

  return { landlets, outerRadiusM, boundarySignature };
}

// The authoritative distribution rounds each non-landlet class down, then
// assigns every remainder to class 1. Sizes within larger classes are uniform.
export function powerLawPlots(count, seed) {
  const random = seededRandom(seed);
  const counts = new Map();
  let allocated = 0;
  for (let landClass = 2; ; landClass += 1) {
    const classCount = Math.floor(count * 0.09 * (10 ** (2 - landClass)));
    if (classCount === 0) break;
    counts.set(landClass, classCount);
    allocated += classCount;
  }
  counts.set(1, count - allocated);

  const plots = [];
  for (const [landClass, classCount] of counts) {
    const minimum = landClass === 1 ? 1000 : 10 ** (landClass + 1) + 1;
    const maximum = landClass === 1 ? 1000 : 10 ** (landClass + 2);
    for (let index = 0; index < classCount; index += 1) {
      plots.push({
        areaM2: minimum + random() * (maximum - minimum),
        landClass,
        metadata: { sizeDistribution: 'power-law-v1' },
      });
    }
  }
  return plots;
}

function ringAreaScale(areas, arcSegments) {
  let low = Math.max(...areas) / arcSegments;
  let high = low * 2;
  const angleSum = (scale) => areas.reduce(
    (sum, area) => sum + arcSegments * Math.asin(Math.min(1, area / (scale * arcSegments))), 0,
  );
  while (angleSum(high) > TAU) high *= 2;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    if (angleSum(middle) > TAU) low = middle;
    else high = middle;
  }
  return high;
}

function seededRandom(seed) {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.codePointAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function polar(radius, angle) {
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

function polygonCentroid(points) {
  let crossSum = 0;
  let xSum = 0;
  let ySum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    crossSum += cross;
    xSum += (current.x + next.x) * cross;
    ySum += (current.y + next.y) * cross;
  }
  return { x: xSum / (3 * crossSum), y: ySum / (3 * crossSum) };
}
