import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDuration,
  isFailedStatus,
  notificationStats,
  splitTaskNotifications,
  type TaskSegment,
} from '../src/lib/task-notification.ts';

const notes = (segments: TaskSegment[]) =>
  segments.flatMap((segment) => (segment.type === 'notification' ? [segment.notification] : []));

const block = (id: string, extra = '') =>
  `<task-notification><task-id>${id}</task-id><status>completed</status><summary>S${id}</summary>${extra}</task-notification>`;

await test('parses a completed notification with usage', () => {
  const segments = splitTaskNotifications(
    '<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent "Review" finished</summary> <note>noise</note> <usage> <subagent_tokens>28188</subagent_tokens><tool_uses>6</tool_uses><duration_ms>48154</duration_ms> </usage> </task-notification>',
  );
  assert.equal(segments.length, 1);
  const notifications = notes(segments);
  assert.deepEqual(notifications, [
    {
      taskId: 'a1',
      status: 'completed',
      summary: 'Agent "Review" finished',
      tokens: 28188,
      toolUses: 6,
      durationMs: 48154,
    },
  ]);
  assert.deepEqual(notificationStats(notifications[0]), ['28,188 tokens', '6 tool uses', '48s']);
});

await test('stopped notification without usage has no stats', () => {
  const notifications = notes(
    splitTaskNotifications(
      '<task-notification><task-id>b2</task-id><status>stopped</status><summary>x</summary></task-notification>',
    ),
  );
  assert.equal(notifications[0].status, 'stopped');
  assert.deepEqual(notificationStats(notifications[0]), []);
});

await test('ordinary text passes through untouched', () => {
  for (const text of ['hello', '<task-notification></task-notification>', '<task-notification>']) {
    assert.deepEqual(splitTaskNotifications(text), [{ type: 'text', text }]);
  }
});

await test('back-to-back notifications give one card each', () => {
  const segments = splitTaskNotifications(block('A') + block('B'));
  assert.deepEqual(
    notes(segments).map((n) => n.summary),
    ['SA', 'SB'],
  );
  assert.equal(segments.length, 2);
});

await test('text and notifications keep their order', () => {
  const segments = splitTaskNotifications(`before ${block('A')} middle ${block('B')} after`);
  assert.deepEqual(
    segments.map((s) => (s.type === 'text' ? s.text : s.notification.summary)),
    ['before', 'SA', 'middle', 'SB', 'after'],
  );
});

await test('result text cannot hijack usage fields', () => {
  const notifications = notes(
    splitTaskNotifications(
      block(
        'A',
        '<result>see <tool_uses>99</tool_uses><summary>evil</summary></result><usage><tool_uses>2</tool_uses></usage>',
      ),
    ),
  );
  assert.equal(notifications[0].toolUses, 2);
  assert.equal(notifications[0].summary, 'SA');
});

await test('oversized numbers fall back instead of showing Infinity', () => {
  const huge = '9'.repeat(400);
  const notifications = notes(
    splitTaskNotifications(
      block(
        'A',
        `<usage><subagent_tokens>${huge}</subagent_tokens><duration_ms>9007199254740993</duration_ms><tool_uses>3</tool_uses></usage>`,
      ),
    ),
  );
  assert.deepEqual(notificationStats(notifications[0]), ['3 tool uses']);
});

await test('empty and invalid fields fall back instead of showing zeros', () => {
  const notifications = notes(
    splitTaskNotifications(
      '<task-notification><task-id>a</task-id><status></status><summary> </summary><usage><subagent_tokens></subagent_tokens><tool_uses>0x10</tool_uses><duration_ms>-5</duration_ms></usage></task-notification>',
    ),
  );
  assert.deepEqual(notifications[0], {
    taskId: 'a',
    status: 'unknown',
    summary: 'Subagent update',
    tokens: undefined,
    toolUses: undefined,
    durationMs: undefined,
  });
});

await test('decodes XML entities in the summary', () => {
  const notifications = notes(
    splitTaskNotifications(
      '<task-notification><task-id>a</task-id><summary>R&amp;D &lt;x&gt; &amp;lt;</summary></task-notification>',
    ),
  );
  assert.equal(notifications[0].summary, 'R&D <x> &lt;');
});

await test('formats durations and failure statuses', () => {
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.ok(isFailedStatus('killed'));
  assert.ok(!isFailedStatus('stopped'));
});
