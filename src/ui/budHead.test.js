// #4430: the logo sits at the centre of the turned bud's body, as the eye sees it (the area centroid of the
// turned shape, not the middle of its bounding box: a pointed shape's box centre is not its visual centre).
// Reads public/bud-head.svg itself, so the next change of the head's shape or turn cannot move the logo unnoticed.
import { describe, it, expect } from 'vitest';
import svg from '../../public/bud-head.svg?raw';

function bodyPolygon() {
  const d = svg.match(/<path d="(M28 2 C[^"]+)" fill="#6ca42e"/)[1];
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const pts = [];
  let [px, py] = [nums[0], nums[1]];
  for (let i = 2; i + 5 < nums.length + 0; i += 6) {
    const [x1, y1, x2, y2, x3, y3] = nums.slice(i, i + 6);
    for (let k = 0; k < 200; k++) {
      const t = k / 200, u = 1 - t;
      pts.push([u ** 3 * px + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3,
        u ** 3 * py + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3]);
    }
    [px, py] = [x3, y3];
  }
  return pts;
}

function centroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    const cross = x0 * y1 - x1 * y0;
    a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
  }
  a /= 2;
  return [cx / (6 * a), cy / (6 * a)];
}

describe('the head (public/bud-head.svg)', () => {
  it('centres the logo on the turned bud body\'s centroid, within a pixel or two', () => {
    const turn = svg.match(/rotate\((-?\d+(?:\.\d+)?) (\d+) (\d+)\)/);
    const [deg, ox, oy] = [Number(turn[1]), Number(turn[2]), Number(turn[3])];
    const [cx, cy] = centroid(bodyPolygon());
    const th = (deg * Math.PI) / 180;
    const body = [ox + (cx - ox) * Math.cos(th) - (cy - oy) * Math.sin(th), oy + (cx - ox) * Math.sin(th) + (cy - oy) * Math.cos(th)];
    const logo = svg.match(/<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
    const [lx, ly, lw, lh] = logo.slice(1, 5).map(Number);
    expect(Math.abs(lx + lw / 2 - body[0])).toBeLessThan(1);
    expect(Math.abs(ly + lh / 2 - body[1])).toBeLessThan(1);
  });
});
