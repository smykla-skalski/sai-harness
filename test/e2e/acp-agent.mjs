import { createInterface } from 'node:readline';
import process from 'node:process';

const sessions = new Map();
const permissions = new Map();
const terminalRequests = new Map();
let terminalSupport = false;
let nextTerminalRequest = 3000;
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

function terminalRequest(method, params, callback) {
  const id = ++nextTerminalRequest;
  terminalRequests.set(id, callback);
  send({ id, method, params });
}

function runTerminal(sessionId, text, promptId) {
  if (!terminalSupport) {
    send({ id: promptId, error: { code: -1, message: 'Client terminal support missing' } });
    return;
  }
  const stop = text.includes('stop');
  const script = stop
    ? 'echo started; sleep 30; echo done'
    : 'echo started; sleep 1; echo finished; exit 7';
  terminalRequest(
    'terminal/create',
    { sessionId, command: '/bin/sh', args: ['-c', script], outputByteLimit: 1024 },
    ({ result, error }) => {
      if (error) {
        send({ id: promptId, error });
        return;
      }
      const terminalId = result.terminalId;
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: `terminal-${terminalId}`,
        title: 'Run terminal fixture',
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId }],
      });
      terminalRequest('terminal/wait_for_exit', { sessionId, terminalId }, ({ result: status }) => {
        terminalRequest('terminal/output', { sessionId, terminalId }, ({ result: output }) => {
          update(sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: `terminal-${terminalId}`,
            status: 'completed',
            content: [
              { type: 'terminal', terminalId },
              {
                type: 'content',
                content: { type: 'text', text: `${output.output}\n${JSON.stringify(status)}` },
              },
            ],
          });
          terminalRequest('terminal/release', { sessionId, terminalId }, () => {
            send({ id: promptId, result: { stopReason: 'end_turn' } });
          });
        });
      });
    },
  );
}

function configOptions(sessionId) {
  const session = sessions.get(sessionId);
  const config = session?.config ?? { model: 'test', effort: 'medium' };
  const options = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: config.model,
      options: [
        { value: 'test', name: 'Test model' },
        { value: 'fast', name: 'Fast model' },
        { value: 'broken', name: 'Reject model' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      type: 'select',
      currentValue: config.effort,
      options: [
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
  ];
  return session?.noEffort ? options.slice(0, 1) : options;
}

function requestPermission(sessionId, text, promptId) {
  const id = ++nextPermission;
  permissions.set(id, { sessionId, text, promptId });
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
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.method && terminalRequests.has(message.id)) {
    terminalRequests.get(message.id)(message);
    terminalRequests.delete(message.id);
    continue;
  }
  if (message.method === 'initialize') {
    terminalSupport = message.params.clientCapabilities?.terminal === true;
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
    sessions.set(sessionId, { history: [], config: { model: 'test', effort: 'medium' } });
    setTimeout(
      () =>
        send({ id: message.id, result: { sessionId, configOptions: configOptions(sessionId) } }),
      1000,
    );
  } else if (message.method === 'session/load') {
    const session = sessions.get(message.params.sessionId);
    if (!session) send({ id: message.id, error: { code: -1, message: 'Session missing' } });
    else {
      for (const item of session.history) update(message.params.sessionId, item);
      send({
        id: message.id,
        result: {
          sessionId: message.params.sessionId,
          configOptions: configOptions(message.params.sessionId),
        },
      });
    }
  } else if (message.method === 'session/set_config_option') {
    const { sessionId, configId, value } = message.params;
    if (value === 'broken') {
      send({ id: message.id, error: { code: -1, message: 'Model change rejected' } });
      continue;
    }
    sessions.get(sessionId).config[configId] = value;
    send({ id: message.id, result: { configOptions: configOptions(sessionId) } });
  } else if (message.method === 'session/prompt') {
    const { sessionId } = message.params;
    const text = message.params.prompt[0].text;
    if (text === 'Disable effort') {
      sessions.get(sessionId).noEffort = true;
      update(sessionId, {
        sessionUpdate: 'config_option_update',
        configOptions: configOptions(sessionId),
      });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text.startsWith('Terminal:')) {
      runTerminal(sessionId, text, message.id);
      continue;
    }
    const user = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } };
    sessions.get(sessionId).history.push(user);
    update(sessionId, user);
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'review',
      title: 'Run test action',
      status: 'pending',
    });
    if (text.startsWith('Delayed'))
      setTimeout(() => requestPermission(sessionId, text, message.id), 1500);
    else requestPermission(sessionId, text, message.id);
  } else if (message.method === 'session/cancel') {
    for (const [id, pending] of permissions) {
      if (pending.sessionId === message.params.sessionId) {
        permissions.delete(id);
        const finish = () => send({ id: pending.promptId, result: { stopReason: 'cancelled' } });
        if (pending.text === 'Slow cancel') setTimeout(finish, 5000);
        else finish();
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
      message.result?.outcome?.optionId === 'allow'
        ? pending.text === 'Long answer'
          ? Array.from({ length: 100 }, (_, index) => `Answer line ${index}`).join('\n')
          : pending.text === 'Link example'
            ? '[Example](https://example.com/path) [Section](#section) [Unsafe](javascript:alert(1))'
            : `Done: ${pending.text}`
        : 'Rejected';
    const finish = () => {
      const reply = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
      sessions.get(pending.sessionId).history.push(reply);
      update(pending.sessionId, reply);
      send({ id: pending.promptId, result: { stopReason: 'end_turn' } });
    };
    if (pending.text === 'Delayed completion') setTimeout(finish, 1000);
    else finish();
  }
}
