import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectGraph } from '../src/lib/sync/graph.ts';
import type { Revision } from '../src/lib/sync/drive.ts';
const revision = (id: string, parents: string[] = []): Revision => ({
  id,
  parents,
  fileId: id,
  contentVersion: '1',
  createdAt: '2026-09-21T00:00:00Z',
  sha256: 'a'.repeat(64)
});

test('overlapping cycles remove exactly their strongly connected components', () => {
  const graph = inspectGraph([
    revision('a', ['b', 'c']),
    revision('b', ['a']),
    revision('c', ['b']),
    revision('healthy', ['c'])
  ]);
  assert.deepEqual(graph.invalidIds.sort(), ['a', 'b', 'c']);
  assert.deepEqual(
    graph.heads.map((head) => head.id),
    ['healthy']
  );
});

test('branched histories select the nearest unambiguous common ancestor', () => {
  const graph = inspectGraph([
    revision('root'),
    revision('base', ['root']),
    revision('a', ['base']),
    revision('b', ['base'])
  ]);
  assert.deepEqual(graph.common, { a: null, b: 'base' });
});

test('missing ancestry always uses a conservative empty merge base', () => {
  const graph = inspectGraph([
    revision('base', ['missing']),
    revision('a', ['base']),
    revision('b', ['base'])
  ]);
  assert.deepEqual(graph.common, { a: null, b: null });
  assert.deepEqual(graph.invalidIds, []);
});
