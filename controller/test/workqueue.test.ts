import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkQueue } from '../src/workqueue.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('work added during the shared pass is still done', async () => {
  // The race behind tenant-phoenix-claw staying Observing: a spec change
  // arrives while the worker is in the pass after the queue emptied.
  const done: string[] = [];
  let passes = 0;
  let addDuringPass: (() => void) | undefined;
  const q = new WorkQueue(
    async (n) => { await tick(); done.push(n); },
    async () => { passes++; await tick(); addDuringPass?.(); addDuringPass = undefined; await tick(); },
  );
  addDuringPass = () => void q.add('b');
  await q.add('a');
  assert.deepEqual(done, ['a', 'b']);
  assert.equal(passes, 2);
  assert.equal(q.size, 0);
});

test('work added during a reconcile is done in the same run', async () => {
  const done: string[] = [];
  const q = new WorkQueue(async (n) => { if (n === 'a') void q.add('b'); await tick(); done.push(n); });
  await q.add('a');
  assert.deepEqual(done, ['a', 'b']);
});

test('a name queued twice while busy is done once more, not twice', async () => {
  const done: string[] = [];
  const q = new WorkQueue(async (n) => { if (n === 'a' && done.length === 0) { void q.add('x'); void q.add('x'); } await tick(); done.push(n); });
  await q.add('a');
  assert.deepEqual(done, ['a', 'x']);
});
