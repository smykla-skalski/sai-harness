import assert from 'node:assert/strict';
import test from 'node:test';
import { updateEntries } from '../src/lib/acp.ts';

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
