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
  });
});
