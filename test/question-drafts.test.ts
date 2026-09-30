import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotAnswers } from '../src/lib/plan.ts';

await test('snapshots reactive answer arrays before submission', () => {
  const text = new Proxy(['draft'], {});
  const answers = new Proxy({ text }, {});

  assert.throws(() => structuredClone(answers), { name: 'DataCloneError' });
  const snapshot = snapshotAnswers(answers);
  assert.deepEqual(snapshot, { text: ['draft'] });

  text[0] = 'changed while sending';
  assert.deepEqual(snapshot, { text: ['draft'] });
});
