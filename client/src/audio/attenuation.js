// Distance-based volume model for ProxiSpeak.
// Returns a linear gain between 0 and 1.
export function calculateAttenuation(distance, maxDistance = 100) {
  if (!Number.isFinite(distance) || !Number.isFinite(maxDistance) || maxDistance <= 0) {
    return 0;
  }
  if (distance <= 0) return 1;
  if (distance >= maxDistance) return 0;

  // Smoothstep falloff avoids an abrupt-feeling linear volume change.
  const ratio = distance / maxDistance;
  const smooth = ratio * ratio * (3 - 2 * ratio);
  return Math.max(0, Math.min(1, 1 - smooth));
}

// Map horizontal avatar displacement to Web Audio's [-1, 1] pan range.
export function calculateStereoPan(deltaX, maxDistance = 100) {
  if (!Number.isFinite(deltaX) || !Number.isFinite(maxDistance) || maxDistance <= 0) {
    return 0;
  }
  return Math.max(-1, Math.min(1, deltaX / maxDistance));
}
