import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coordinationKey,
  coordinationMessageForText,
  coordinationPrompt,
  enqueueCoordinationMessage,
  loadCoordinationMessages,
} from '../src/lib/coordination.ts';

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

await test('message queue prunes delivered entries before pending entries', () => {
  const message = {
    id: 'new',
    target: 'target',
    sender: 'Agent',
    text: 'Hello',
    created: 3,
  };
  const pending = { ...message, id: 'pending', created: 1 };
  const delivered = { ...message, id: 'delivered', created: 2, delivered: true };
  assert.deepEqual(enqueueCoordinationMessage([pending, delivered], message, 2), [
    pending,
    message,
  ]);
  assert.throws(() => enqueueCoordinationMessage([pending], message, 1), /queue is full/);
});

await test('delivered prompt matches its transcript entry for sender attribution', () => {
  const message = {
    id: 'message-1',
    target: 'target',
    sender: 'Claude · Review',
    text: 'Please test',
    created: 123,
  };
  const prompt = coordinationPrompt(message);
  assert.equal(coordinationMessageForText(prompt, [message]), message);
  assert.equal(coordinationMessageForText('Unrelated user prompt', [message]), undefined);
});
