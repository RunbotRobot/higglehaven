import { polygonCentroid, seededRandom } from './landGenerator.js';
import { ORGANIC_MOSAIC_TEMPLATE } from './organicMosaicTemplate.js';

// The equal-area power diagram and its shared curved seams are precomputed
// offline in organicMosaicTemplate.js. Request-time work is deliberately only
// a rigid rotation and serialization, keeping this free-tier Worker endpoint
// well below the CPU cost of solving a power diagram inline.
export function generateOrganicMosaic({ prefix, count, seed = prefix, areaM2 = 1000 }) {
  if (count !== ORGANIC_MOSAIC_TEMPLATE.length || areaM2 !== 1000) {
    throw new RangeError('organic-mosaic-v1 requires exactly 16 lands of 1,000 m2');
  }
  const angle = seededRandom(seed)() * Math.PI * 2;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);

  return ORGANIC_MOSAIC_TEMPLATE.map((template, index) => {
    const worldPolygon = template.polygon.map((point) => rotate({
      x: template.center.x + point.x,
      y: template.center.y + point.y,
    }, cosine, sine));
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

function rotate(point, cosine, sine) {
  return { x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine };
}
