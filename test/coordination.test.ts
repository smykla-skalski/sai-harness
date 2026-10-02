import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinationKey, loadCoordinationMessages } from '../src/lib/coordination.ts';

await test('messages keep sender and target across reload', () => {
  const target = coordinationKey('/repo/worktree', 'acp:claude:session-1');
  const message = {
    id: 'message-1',
    target,
    sender: 'Claude · Review',
    text: 'Please test',
    created: 123,
  };
  assert.deepEqual(loadCoordinationMessages(JSON.stringify([message])), [message]);
  assert.deepEqual(loadCoordinationMessages('{broken'), []);
  assert.deepEqual(
    loadCoordinationMessages(JSON.stringify([{ ...message, created: 'wrong' }])),
    [],
  );
  assert.deepEqual(
    loadCoordinationMessages(JSON.stringify([{ ...message, delivered: 'wrong' }])),
    [],
  );
});
