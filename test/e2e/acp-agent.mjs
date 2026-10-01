import { createInterface } from 'node:readline';
import process from 'node:process';

const sessions = new Map();
const permissions = new Map();
const agent = process.argv[2];
let authenticated = agent !== 'codex';
let nextSession = 0;
let nextPermission = 1000;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function update(sessionId, value) {
  send({ method: 'session/update', params: { sessionId, update: value } });
}

function configOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'test',
      options: [{ value: 'test', name: 'Test model' }],
    },
  ];
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: agent === 'codex' ? [{ id: 'chat-gpt', name: 'ChatGPT' }] : [],
      },
    });
  } else if (message.method === 'authenticate') {
    authenticated = message.params.methodId === 'chat-gpt';
    send({ id: message.id, result: {} });
  } else if (message.method === 'session/new') {
    if (!authenticated) {
      send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
      continue;
    }
    const sessionId = `test-${++nextSession}`;
    sessions.set(sessionId, []);
    send({ id: message.id, result: { sessionId, configOptions: configOptions() } });
  } else if (message.method === 'session/load') {
    const history = sessions.get(message.params.sessionId);
    if (!history) send({ id: message.id, error: { code: -1, message: 'Session missing' } });
    else {
      for (const item of history) update(message.params.sessionId, item);
      send({
        id: message.id,
        result: { sessionId: message.params.sessionId, configOptions: configOptions() },
      });
    }
  } else if (message.method === 'session/set_config_option') {
    send({ id: message.id, result: { configOptions: configOptions() } });
  } else if (message.method === 'session/prompt') {
    const { sessionId } = message.params;
    const text = message.params.prompt[0].text;
    const user = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } };
    sessions.get(sessionId).push(user);
    update(sessionId, user);
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'review',
      title: 'Run test action',
      status: 'pending',
    });
    const id = ++nextPermission;
    permissions.set(id, { sessionId, text, promptId: message.id });
    send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'review', title: 'Run test action' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
  } else if (message.method === 'session/cancel') {
    for (const [id, pending] of permissions) {
      if (pending.sessionId === message.params.sessionId) {
        permissions.delete(id);
        send({ id: pending.promptId, result: { stopReason: 'cancelled' } });
      }
    }
  } else if (message.id != null && permissions.has(message.id)) {
    const pending = permissions.get(message.id);
    permissions.delete(message.id);
    update(pending.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'review',
      status: 'completed',
    });
    const text =
      message.result?.outcome?.optionId === 'allow' ? `Done: ${pending.text}` : 'Rejected';
    const reply = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
    sessions.get(pending.sessionId).push(reply);
    update(pending.sessionId, reply);
    send({ id: pending.promptId, result: { stopReason: 'end_turn' } });
  }
}
