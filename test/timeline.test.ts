import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeMessages, nearBottom } from '../src/lib/timeline.ts';
import type { SessionMessageInfo } from '@opencode/client';

const message = (id: string, created: number, text: string): SessionMessageInfo => ({
  id,
  time: { created },
  type: 'user',
  text,
});

await test('reconcile pages by message id, keeping updated content and order', () => {
  const first = [message('old', 1, 'old'), message('middle', 2, 'draft')];
  const second = [message('middle', 2, 'complete'), message('new', 3, 'new')];
  assert.deepEqual(mergeMessages(first, second), [first[0], second[0], second[1]]);
});

await test('follow only when within the bottom threshold', () => {
  assert.equal(nearBottom({ scrollHeight: 500, scrollTop: 210, clientHeight: 200 }), false);
  assert.equal(nearBottom({ scrollHeight: 500, scrollTop: 230, clientHeight: 200 }), true);
});
