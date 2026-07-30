export function landletMaxWorldRadius(row) {
  const polygon = parsePolygon(row.polygon_json);
  if (polygon.length === 0) {
    return Math.hypot(row.center_x_m, row.center_y_m) + sameAreaRadius(row.area_m2);
  }
  return Math.max(...worldPoints(row, polygon).map((point) => Math.hypot(point.x, point.y)));
}

export function landletMinWorldRadius(row) {
  const polygon = parsePolygon(row.polygon_json);
  const centerRadius = Math.hypot(row.center_x_m, row.center_y_m);
  if (polygon.length === 0) return Math.max(0, centerRadius - sameAreaRadius(row.area_m2));

  const points = worldPoints(row, polygon);
  if (pointInPolygon({ x: 0, y: 0 }, points)) return 0;
  return Math.min(...points.map((point, index) => pointToSegmentDistance(
    { x: 0, y: 0 },
    point,
    points[(index + 1) % points.length],
  )));
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function parsePolygon(value) {
  return JSON.parse(value || '[]');
}

function worldPoints(row, polygon) {
  return polygon.map((point) => ({ x: row.center_x_m + point.x, y: row.center_y_m + point.y }));
}

function sameAreaRadius(areaM2) {
  return Math.sqrt(areaM2 / Math.PI);
}
