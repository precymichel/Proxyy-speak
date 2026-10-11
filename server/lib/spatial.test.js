import test from 'node:test';
import assert from 'node:assert/strict';
import { distance2D, attenuate } from './spatial.js';

test('distance2D calculates Euclidean distance', () => {
  assert.equal(distance2D({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});
test('distance2D rejects invalid coordinates', () => {
  assert.throws(() => distance2D({ x: NaN, y: 0 }, { x: 0, y: 0 }), TypeError);
});
test('attenuate fades audio to zero at max distance', () => {
  assert.equal(attenuate(0), 1);
  assert.equal(attenuate(150), 0.5);
  assert.equal(attenuate(300), 0);
});
