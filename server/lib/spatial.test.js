
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distance2D,
  attenuate,
  filterNearbyUsers,
  clusterUsers
} from './spatial.js';

test('distance2D calculates Euclidean distance', () => {
  assert.equal(distance2D({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

test('distance2D rejects invalid coordinates', () => {
  assert.throws(
    () => distance2D({ x: NaN, y: 0 }, { x: 0, y: 0 }),
    TypeError
  );
});

test('attenuate fades audio to zero at max distance', () => {
  assert.equal(attenuate(0), 1);
  assert.equal(attenuate(150), 0.5);
  assert.equal(attenuate(300), 0);
});

test('filters nearby users in the same room only', () => {
  const current = { id: 'a', roomId: 'room1', x: 0, y: 0 };

  const users = [
    { id: 'a', roomId: 'room1', x: 10, y: 10 },
    { id: 'b', roomId: 'room1', x: 60, y: 0 },
    { id: 'c', roomId: 'room1', x: 150, y: 0 },
    { id: 'd', roomId: 'room2', x: 20, y: 0 }
  ];

  assert.deepEqual(
    filterNearbyUsers(users, current, 100).map(user => user.id),
    ['b']
  );
});

test('includes users exactly on the radius boundary', () => {
  const current = { id: 'a', roomId: 'r1', x: 0, y: 0 };
  const users = [
    { id: 'b', roomId: 'r1', x: 100, y: 0 }
  ];

  assert.equal(filterNearbyUsers(users, current, 100).length, 1);
});

test('clusters users by coordinate cell and room', () => {
  const users = [
    { id: 'a', roomId: 'r1', x: 10, y: 10 },
    { id: 'b', roomId: 'r1', x: 20, y: 20 },
    { id: 'c', roomId: 'r1', x: 150, y: 10 },
    { id: 'd', roomId: 'r2', x: 10, y: 10 }
  ];

  const clusters = clusterUsers(users, 100);

  assert.equal(clusters.get('r1:0:0').length, 2);
  assert.equal(clusters.get('r1:1:0').length, 1);
  assert.equal(clusters.get('r2:0:0').length, 1);
});

test('rejects invalid clustering cell size', () => {
  assert.throws(() => clusterUsers([], 0), TypeError);
});
