import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forgetRecentTranscript,
  groupAgentEntries,
  loadRecentTranscript,
  saveRecentTranscript,
  updateEntries,
  type AgentEntry,
  type AgentThread,
} from '../src/lib/acp.ts';

void test('ACP chunks stream into one assistant message and tool updates keep their place', () => {
  const first = updateEntries([], {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello' },
  });
  const second = updateEntries(first, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ' world' },
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].type === 'assistant' && second[0].text, 'Hello world');

  const withTool = updateEntries(second, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-1',
    title: 'Read file',
    status: 'pending',
  });
  const completed = updateEntries(withTool, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Done' } }],
  });
  assert.equal(completed.length, 2);
  assert.deepEqual(completed[1], {
    id: 'tool-1',
    type: 'tool',
    title: 'Read file',
    status: 'completed',
    content: 'Done',
    terminalIds: [],
  });
});

void test('ACP tool calls keep terminal references across updates', () => {
  const created = updateEntries([], {
    sessionUpdate: 'tool_call',
    toolCallId: 'run',
    title: 'Run tests',
    content: [{ type: 'terminal', terminalId: 'terminal-1' }],
  });
  const completed = updateEntries(created, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'run',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Finished' } }],
  });
  assert.deepEqual(completed[0]?.type === 'tool' && completed[0].terminalIds, ['terminal-1']);
});

void test('recent transcript cache keeps the latest entries within a size budget', () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  });
  try {
    const thread: AgentThread = {
      agent: 'codex',
      directory: '/repo',
      sessionId: 'old',
      title: 'Old',
      updated: 0,
    };
    const entries = Array.from({ length: 60 }, (_, index) => ({
      id: String(index),
      type: 'assistant' as const,
      text: String(index).padEnd(100, 'x'),
    }));
    saveRecentTranscript(thread, entries);
    const saved = loadRecentTranscript(thread);
    assert.equal(saved.length, 50);
    assert.equal(saved[0]?.id, '10');
    assert.equal(saved.at(-1)?.id, '59');

    saveRecentTranscript(thread, [{ id: 'large', type: 'assistant', text: 'x'.repeat(500_000) }]);
    assert.ok((values.get('sai-agent-transcript-cache')?.length ?? 0) < 130_000);
    assert.equal(loadRecentTranscript(thread).at(-1)?.id, 'large');
    saveRecentTranscript(thread, [
      { id: 'x'.repeat(200_000), type: 'assistant', text: 'oversized' },
      { id: 'small', type: 'assistant', text: 'kept' },
    ]);
    assert.deepEqual(
      loadRecentTranscript(thread).map((entry) => entry.id),
      ['small'],
    );
    assert.ok((values.get('sai-agent-transcript-cache')?.length ?? 0) <= 128 * 1024);
    saveRecentTranscript(thread, [
      {
        id: 'tool',
        type: 'tool',
        title: 'x'.repeat(200_000),
        status: 'completed',
        content: '',
        terminalIds: [],
      },
    ]);
    assert.deepEqual(loadRecentTranscript(thread), []);
    assert.ok((values.get('sai-agent-transcript-cache')?.length ?? 0) <= 128 * 1024);
    saveRecentTranscript(thread, [
      {
        id: 'unicode',
        type: 'tool',
        title: '😀'.repeat(40_000),
        status: 'completed',
        content: '',
        terminalIds: [],
      },
      { id: 'after', type: 'assistant', text: 'kept' },
    ]);
    assert.deepEqual(
      loadRecentTranscript(thread).map((entry) => entry.id),
      ['after'],
    );
    assert.ok(
      new TextEncoder().encode(values.get('sai-agent-transcript-cache') ?? '').length <= 128 * 1024,
    );
    forgetRecentTranscript(thread);
    assert.deepEqual(loadRecentTranscript(thread), []);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

void test('consecutive ACP tools form a stable group between visible messages', () => {
  const entries: AgentEntry[] = [
    { id: 'message-1', type: 'assistant', text: 'Checking files.' },
    {
      id: 'read',
      type: 'tool',
      title: 'Read files',
      status: 'completed',
      content: '',
      terminalIds: [],
    },
    {
      id: 'test',
      type: 'tool',
      title: 'Run tests',
      status: 'in_progress',
      content: '',
      terminalIds: [],
    },
    { id: 'message-2', type: 'assistant', text: 'I found the issue.' },
  ];
  const grouped = groupAgentEntries(entries);
  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped[0], entries[0]);
  assert.deepEqual(grouped[1], {
    id: 'tool-group:read',
    type: 'tool-group',
    tools: [entries[1], entries[2]],
  });
  assert.deepEqual(grouped[2], entries[3]);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['message-1', 'read', 'test', 'message-2'],
  );
});
