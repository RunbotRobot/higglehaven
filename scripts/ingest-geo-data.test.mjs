import { describe, expect, it } from 'vitest';
import { computeWaterbodyBbox } from './ingest-geo-data.mjs';

// #1566: padDeg converts a target meter distance to degrees using the
// latitude-only conversion (111,000 m/degree), then used to apply that
// same degree value to both latitude and longitude -- but a degree of
// longitude is only 111,000*cos(latitude) meters, so the east-west pad
// shrank well below the intended margin away from the equator (this
// app's real world origin is Seattle, ~47.64°N).
describe('computeWaterbodyBbox (#1566)', () => {
  it('pads longitude wider than latitude away from the equator, matching the true meters-per-degree ratio', () => {
    const originLat = 47.638887; // WORLD_ORIGIN_LATITUDE (worker/earthCurvature.js)
    const originLon = -122.330412; // WORLD_ORIGIN_LONGITUDE
    const radiusM = 2000;
    const [minLon, minLat, maxLon, maxLat] = computeWaterbodyBbox({ originLat, originLon, radiusM })
      .split(',')
      .map(Number);

    const latPadDeg = maxLat - originLat;
    const lonPadDeg = maxLon - originLon;
    const expectedRatio = 1 / Math.cos((originLat * Math.PI) / 180);

    expect(minLat).toBeCloseTo(originLat - latPadDeg, 10);
    expect(minLon).toBeCloseTo(originLon - lonPadDeg, 10);
    // The longitude pad must be wider than the latitude pad by exactly
    // 1/cos(latitude) -- at Seattle's latitude that's a real, measurable
    // ~48% wider, not the bug's previous 1:1 ratio.
    expect(lonPadDeg / latPadDeg).toBeCloseTo(expectedRatio, 10);
    expect(lonPadDeg).toBeGreaterThan(latPadDeg);

    // The actual east-west ground distance the pad covers, using the true
    // meters-per-degree-of-longitude at this latitude, must reach the
    // intended 1.5x-radius margin -- not fall short of it the way the
    // original latitude-only conversion did.
    const metersPerDegreeLon = 111000 * Math.cos((originLat * Math.PI) / 180);
    const eastWestMarginM = lonPadDeg * metersPerDegreeLon;
    expect(eastWestMarginM).toBeCloseTo(radiusM * 1.5, 0);
  });
});
