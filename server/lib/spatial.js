
export function distance2D(a, b) {
  if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) {
    throw new TypeError('Coordinates must be finite numbers');
  }

  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function attenuate(distance, maxDistance = 300) {
  if (
    !Number.isFinite(distance) ||
    distance < 0 ||
    !Number.isFinite(maxDistance) ||
    maxDistance <= 0
  ) {
    throw new TypeError(
      'Distance must be non-negative and maxDistance must be positive'
    );
  }

  return Math.max(0, Math.min(1, 1 - distance / maxDistance));
}

// Return users in the same room who are within the given radius.
export function filterNearbyUsers(
  users,
  currentUser,
  radius = 100
) {
  if (!Array.isArray(users)) {
    throw new TypeError('users must be an array');
  }

  if (!Number.isFinite(radius) || radius < 0) {
    throw new TypeError('radius must be a non-negative number');
  }

  return users.filter((user) => {
    if (!user || user.id === currentUser?.id) return false;
    if (user.roomId !== currentUser?.roomId) return false;

    return distance2D(currentUser, user) <= radius;
  });
}

// Group users into spatial cells for efficient local queries.
export function clusterUsers(users, cellSize = 100) {
  if (!Array.isArray(users)) {
    throw new TypeError('users must be an array');
  }

  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new TypeError('cellSize must be a positive number');
  }

  const clusters = new Map();

  for (const user of users) {
    if (!user || !Number.isFinite(user.x) || !Number.isFinite(user.y)) {
      throw new TypeError('Each user must have finite x and y coordinates');
    }

    const cellX = Math.floor(user.x / cellSize);
    const cellY = Math.floor(user.y / cellSize);
    const key = `${user.roomId ?? ''}:${cellX}:${cellY}`;

    if (!clusters.has(key)) {
      clusters.set(key, []);
    }

    clusters.get(key).push(user);
  }

  return clusters;
}
