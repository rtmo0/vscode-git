import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { layoutGraph, Segment } from '../src/log/graph';

const c = (hash: string, ...parents: string[]) => ({ hash, parents });
const seg = (s: Segment) => `${s.half[0]}${s.from}${s.to}`;

test('a linear history stays in one lane', () => {
  const rows = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows.map((r) => r.segments.map(seg)), [['b00'], ['t00', 'b00'], ['t00']]);
  assert.ok(rows.every((r) => r.color === rows[0].color));
});

test('a merge opens a lane for the second parent, which joins back at the fork point', () => {
  //  m        merge of f into main
  //  |\
  //  x |      main commit
  //  | f      feature commit
  //  |/
  //  a
  const rows = layoutGraph([c('m', 'x', 'f'), c('x', 'a'), c('f', 'a'), c('a')]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 1, 0]);
  assert.deepEqual(rows[0].segments.map(seg), ['b00', 'b01']);
  assert.deepEqual(rows[1].segments.map(seg), ['t00', 't11', 'b00', 'b11']);
  // f's first parent a is already the target of lane 0: f's line joins it.
  assert.deepEqual(rows[2].segments.map(seg), ['t00', 't11', 'b00', 'b10']);
  assert.deepEqual(rows[3].segments.map(seg), ['t00']);
  assert.notEqual(rows[2].color, rows[0].color);
  assert.equal(rows[3].color, rows[0].color);
});

test('two branch tips get separate lanes and lanes compact when a line ends', () => {
  //  t1        tip of branch 1
  //  | t2      tip of branch 2
  //  |/
  //  b
  const rows = layoutGraph([c('t1', 'b'), c('t2', 'b'), c('b')]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0]);
  // t2 has no line above; its parent b is already the target of lane 0, so the node joins it.
  assert.deepEqual(rows[1].segments.map(seg), ['t00', 'b00', 'b10']);
  assert.equal(rows[2].width, 1);
});
