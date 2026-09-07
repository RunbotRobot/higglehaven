import { describe, expect, it } from 'vitest';
import {
  classifyPreHumanWaterType,
  destinationPoint,
  distanceToPolygonM,
  haversineDistanceM,
  initialBearingDeg,
  latLonToWorld,
  pointInPolygon,
  PRE_1916_LAKE_WASHINGTON_LEVEL_M,
  worldToLatLon,
} from './geoData.js';

describe('haversineDistanceM / initialBearingDeg / destinationPoint', () => {
  it('measures ~111.2km per degree of latitude on Earth-scale radius', () => {
    const d = haversineDistanceM(47.0, -122.0, 48.0, -122.0);
    expect(d).toBeCloseTo(111195, -2);
  });

  it('bearing due north is 0, due east is 90', () => {
    expect(initialBearingDeg(0, 0, 1, 0)).toBeCloseTo(0, 6);
    expect(initialBearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 3);
  });

  it('destinationPoint inverts distance+bearing back to the original point', () => {
    const dest = destinationPoint(47.638887, -122.280433, 37, 500);
    const back = haversineDistanceM(47.638887, -122.280433, dest.lat, dest.lon);
    expect(back).toBeCloseTo(500, 3);
    expect(initialBearingDeg(47.638887, -122.280433, dest.lat, dest.lon)).toBeCloseTo(37, 3);
  });
});

describe('latLonToWorld / worldToLatLon', () => {
  it('maps the world origin to (0, 0)', () => {
    const p = latLonToWorld(47.638887, -122.280433, { originLat: 47.638887, originLon: -122.280433 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it('round-trips an arbitrary nearby point through the 210-degree rotation', () => {
    const originLat = 47.638887;
    const originLon = -122.280433;
    const real = destinationPoint(originLat, originLon, 118, 850);
    const world = latLonToWorld(real.lat, real.lon, { originLat, originLon });
    // Distance from the world origin must be preserved exactly (an
    // azimuthal-equidistant projection's defining property) regardless of
    // which direction the rotational offset points it in.
    expect(Math.hypot(world.x, world.y)).toBeCloseTo(850, 3);
    const back = worldToLatLon(world.x, world.y, { originLat, originLon });
    expect(back.lat).toBeCloseTo(real.lat, 6);
    expect(back.lon).toBeCloseTo(real.lon, 6);
  });

  it('applies the documented 210-degree offset (true north lands at world bearing -120 deg / 240 deg math-angle)', () => {
    const originLat = 47.638887;
    const originLon = -122.280433;
    const real = destinationPoint(originLat, originLon, 0 /* due north */, 300);
    const world = latLonToWorld(real.lat, real.lon, { originLat, originLon });
    // worldAngleDeg = 90 - compassBearing(0) + 210 = 300, i.e. (cos 300, sin 300) * 300.
    expect(world.x).toBeCloseTo(300 * Math.cos((300 * Math.PI) / 180), 2);
    expect(world.y).toBeCloseTo(300 * Math.sin((300 * Math.PI) / 180), 2);
  });
});

describe('pointInPolygon / distanceToPolygonM', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('detects points inside vs. outside a simple polygon', () => {
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false);
  });

  it('measures distance from an outside point to the nearest edge as zero inside, positive outside', () => {
    expect(distanceToPolygonM({ x: 120, y: 50 }, square)).toBeCloseTo(20, 6);
    expect(distanceToPolygonM({ x: -30, y: -40 }, square)).toBeCloseTo(50, 6);
  });
});

describe('classifyPreHumanWaterType', () => {
  it('classifies anything inside the current waterbody as water regardless of elevation', () => {
    expect(
      classifyPreHumanWaterType({ elevationM: 50, inCurrentWaterbody: true, distanceToShorelineM: 0, reclamationRadiusM: 400 })
    ).toBe('water');
  });

  it('reclaims low-lying land near the shore that sat below the pre-1916 lake level', () => {
    expect(
      classifyPreHumanWaterType({
        elevationM: PRE_1916_LAKE_WASHINGTON_LEVEL_M - 1,
        inCurrentWaterbody: false,
        distanceToShorelineM: 100,
        reclamationRadiusM: 400,
      })
    ).toBe('water');
  });

  it('leaves land dry when it is above the pre-1916 lake level even if close to shore', () => {
    expect(
      classifyPreHumanWaterType({
        elevationM: PRE_1916_LAKE_WASHINGTON_LEVEL_M + 1,
        inCurrentWaterbody: false,
        distanceToShorelineM: 10,
        reclamationRadiusM: 400,
      })
    ).toBe('buildable');
  });

  it('never reclaims a low point far from the lake, even below the historical level', () => {
    expect(
      classifyPreHumanWaterType({
        elevationM: 0,
        inCurrentWaterbody: false,
        distanceToShorelineM: 5000,
        reclamationRadiusM: 400,
      })
    ).toBe('buildable');
  });
});
