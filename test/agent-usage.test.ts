import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionMessageInfo } from '@opencode/client';
import { acpUsage, openCodeContextUsage } from '../src/lib/agent-usage.ts';

function assistant(input: number, modelId = 'a', tokens = true): SessionMessageInfo {
  return {
    id: String(input),
    type: 'assistant',
    agent: 'build',
    time: { created: input },
    content: [],
    model: { providerID: 'p', id: modelId },
    ...(tokens
      ? { tokens: { input, output: 50, reasoning: 20, cache: { read: 100, write: 50 } } }
      : {}),
  };
}

void test('ACP context uses reported numbers and hides invalid reports', () => {
  assert.deepEqual(acpUsage({ sessionUpdate: 'usage_update', used: 25, size: 100 }), {
    context: 25,
  });
  assert.deepEqual(acpUsage({ sessionUpdate: 'usage_update', used: 110, size: 100 }), {
    context: 100,
  });
  for (const [used, size] of [
    [null, 100],
    [10, 0],
    [-1, 100],
    [Infinity, 100],
  ])
    assert.deepEqual(acpUsage({ sessionUpdate: 'usage_update', used, size }), {
      context: undefined,
    });
  assert.equal(acpUsage({ sessionUpdate: 'agent_message_chunk' }), null);
});

void test('Claude quota appears only for reported utilization', () => {
  const usage = acpUsage({
    sessionUpdate: 'usage_update',
    used: 50,
    size: 100,
    _meta: {
      '_claude/rateLimit': {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.24 },
          seven_day: { utilization: 0.13 },
        },
      },
    },
  });
  assert.deepEqual(usage, {
    context: 50,
    rates: [
      { label: '5h', remaining: 76 },
      { label: '7d', remaining: 87 },
    ],
  });
  assert.deepEqual(
    acpUsage({
      sessionUpdate: 'usage_update',
      used: 50,
      size: 100,
      _meta: { '_claude/rateLimit': { status: 'allowed', resetsAt: 100 } },
    }),
    { context: 50, rates: [] },
  );
  assert.deepEqual(
    acpUsage({
      sessionUpdate: 'usage_update',
      used: 50,
      size: 100,
      _meta: { '_claude/rateLimit': { rateLimitType: 'five_hour', utilization: 2 } },
    }),
    { context: 50, rates: [] },
  );
  assert.deepEqual(
    acpUsage({
      sessionUpdate: 'usage_update',
      used: 50,
      size: 100,
      _meta: {
        '_claude/rateLimit': {
          rateLimitType: 'five_hour',
          utilization: 0.5,
          resetsAt: 1,
        },
      },
    }),
    { context: 50, rates: [] },
  );
});

void test('OpenCode context uses latest assistant tokens and its model', () => {
  const model = { id: 'a', providerID: 'p', limit: { context: 1000, output: 100 } };
  assert.equal(openCodeContextUsage([assistant(200)], [model]), 42);
  assert.equal(openCodeContextUsage([assistant(200), assistant(100)], [model]), 32);
  assert.equal(openCodeContextUsage([assistant(200), assistant(100, 'b')], [model]), undefined);
  assert.equal(
    openCodeContextUsage([assistant(200), assistant(100, 'a', false)], [model]),
    undefined,
  );
});
