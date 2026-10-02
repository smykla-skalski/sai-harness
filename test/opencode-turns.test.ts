import assert from 'node:assert/strict';
import test from 'node:test';
import { runSerialOpenCodeTurn } from '../src/lib/opencode-turns.ts';

void test('turns in one session start after the prior turn settles', async () => {
  const events: string[] = [];
  let finishFirst!: () => void;
  const first = runSerialOpenCodeTurn('serial-a', async () => {
    events.push('first snapshot');
    await new Promise<void>((resolve) => (finishFirst = resolve));
    events.push('first done');
  });
  const second = runSerialOpenCodeTurn('serial-a', async () => {
    events.push('second snapshot');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first snapshot']);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first snapshot', 'first done', 'second snapshot']);
});

void test('a failed turn does not block later turns', async () => {
  const first = runSerialOpenCodeTurn('serial-b', async () => {
    throw new Error('prompt failed');
  });
  const second = runSerialOpenCodeTurn('serial-b', async () => 'sent');
  await assert.rejects(first, /prompt failed/);
  assert.equal(await second, 'sent');
});
