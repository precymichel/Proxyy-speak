export function distance2D(a, b) {
  if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) {
    throw new TypeError('Coordinates must be finite numbers');
  }
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function attenuate(distance, maxDistance = 300) {
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(maxDistance) || maxDistance <= 0) {
    throw new TypeError('Distance must be non-negative and maxDistance must be positive');
  }
  return Math.max(0, Math.min(1, 1 - distance / maxDistance));
}
