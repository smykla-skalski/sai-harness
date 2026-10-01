import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inboxLocations,
  loadInboxSeen,
  maxInboxSeen,
  openCodeRequestTime,
  sortInbox,
  type InboxItem,
} from '../src/lib/inbox.ts';

const item = (key: string, receivedAt: number): InboxItem => ({
  key,
  receivedAt,
  kind: 'question',
  agent: 'OpenCode',
  directory: '/projects/alpha',
  project: 'alpha',
  worktree: null,
  sessionId: 'session',
  requestId: key,
  text: key,
});

const id = (prefix: string, timestamp: number) =>
  `${prefix}_${((BigInt(timestamp) * 4096n) % (1n << 48n)).toString(16).padStart(12, '0')}${'a'.repeat(14)}`;

void test('inbox covers repositories and worktrees with their parent project', () => {
  assert.deepEqual(
    inboxLocations({
      repositories: ['/projects/alpha', '/projects/beta', 'C:\\projects\\gamma'],
      groups: [],
      worktrees: { '/projects/alpha': [{ path: '/worktrees/feature', branch: 'feature' }] },
    }),
    [
      { directory: '/projects/alpha', project: 'alpha', worktree: null },
      { directory: '/worktrees/feature', project: 'alpha', worktree: 'feature' },
      { directory: '/projects/beta', project: 'beta', worktree: null },
      { directory: 'C:\\projects\\gamma', project: 'gamma', worktree: null },
    ],
  );
});

void test('inbox orders requests by arrival then stable key', () => {
  assert.deepEqual(
    sortInbox([item('later', 20), item('b', 10), item('a', 10)]).map((entry) => entry.key),
    ['a', 'b', 'later'],
  );
  assert.deepEqual(loadInboxSeen('{"a":10,"b":"bad"}'), { a: 10 });
  assert.deepEqual(loadInboxSeen('{broken'), {});
  assert.deepEqual(
    loadInboxSeen(JSON.stringify({ [`opencode:permission:${id('per', 123)}`]: 123, custom: 456 })),
    { custom: 456 },
  );
  assert.equal(
    Object.keys(
      loadInboxSeen(
        JSON.stringify(
          Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`custom:${i}`, i])),
        ),
      ),
    ).length,
    maxInboxSeen,
  );
});

void test('OpenCode request IDs preserve creation order across projects and timestamp wrap', () => {
  const cycle = 2 ** 36;
  const beforeWrap = cycle - 100;
  const afterWrap = cycle + 100;
  assert.equal(openCodeRequestTime(id('per', beforeWrap), afterWrap + 50), beforeWrap);
  assert.equal(openCodeRequestTime(id('frm', afterWrap), afterWrap + 50), afterWrap);
  assert.deepEqual(
    sortInbox([
      item('new project', openCodeRequestTime(id('frm', afterWrap), afterWrap + 50)!),
      item('old project', openCodeRequestTime(id('per', beforeWrap), afterWrap + 50)!),
    ]).map((entry) => entry.key),
    ['old project', 'new project'],
  );
  assert.equal(openCodeRequestTime('custom-id', afterWrap + 50), null);
});
