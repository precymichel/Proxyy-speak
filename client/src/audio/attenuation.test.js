import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAttenuation, calculateStereoPan } from './attenuation.js';

test('attenuation is full at zero distance', () => {
  assert.equal(calculateAttenuation(0, 100), 1);
});

test('attenuation is zero at and beyond the range', () => {
  assert.equal(calculateAttenuation(100, 100), 0);
  assert.equal(calculateAttenuation(120, 100), 0);
});

test('attenuation decreases smoothly with distance', () => {
  const near = calculateAttenuation(20, 100);
  const mid = calculateAttenuation(50, 100);
  const far = calculateAttenuation(80, 100);
  assert.ok(near > mid && mid > far);
  assert.ok(mid > 0 && mid < 1);
});

test('stereo pan clamps to left and right limits', () => {
  assert.equal(calculateStereoPan(-200, 100), -1);
  assert.equal(calculateStereoPan(200, 100), 1);
  assert.equal(calculateStereoPan(0, 100), 0);
});
