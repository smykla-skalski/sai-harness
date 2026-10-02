import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDuration,
  notificationStats,
  parseTaskNotification,
} from '../src/lib/task-notification.ts';

await test('parses a completed notification with usage', () => {
  const parsed = parseTaskNotification(
    '<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent "Review" finished</summary> <note>noise</note> <usage> <subagent_tokens>28188</subagent_tokens><tool_uses>6</tool_uses><duration_ms>48154</duration_ms> </usage> </task-notification>',
  );
  assert.deepEqual(parsed, {
    taskId: 'a1',
    status: 'completed',
    summary: 'Agent "Review" finished',
    tokens: 28188,
    toolUses: 6,
    durationMs: 48154,
  });
  assert.deepEqual(notificationStats(parsed), ['28,188 tokens', '6 tool uses', '48s']);
});

await test('parses a stopped notification without usage', () => {
  const parsed = parseTaskNotification(
    '<task-notification><task-id>b2</task-id><status>stopped</status><summary>x</summary></task-notification>',
  );
  assert.equal(parsed?.status, 'stopped');
  assert.deepEqual(notificationStats(parsed), []);
});

await test('ignores ordinary text and mixed content', () => {
  assert.equal(parseTaskNotification('hello'), undefined);
  assert.equal(
    parseTaskNotification('see <task-notification><task-id>a</task-id></task-notification> ok'),
    undefined,
  );
  assert.equal(parseTaskNotification('<task-notification></task-notification>'), undefined);
});

await test('formats durations', () => {
  assert.equal(formatDuration(90_000), '1m 30s');
});
