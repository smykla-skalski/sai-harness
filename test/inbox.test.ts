import assert from 'node:assert/strict';
import test from 'node:test';
import { inboxLocations, loadInboxSeen, sortInbox, type InboxItem } from '../src/lib/inbox.ts';

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

void test('inbox covers repositories and worktrees with their parent project', () => {
  assert.deepEqual(
    inboxLocations({
      repositories: ['/projects/alpha', '/projects/beta'],
      groups: [],
      worktrees: { '/projects/alpha': [{ path: '/worktrees/feature', branch: 'feature' }] },
    }),
    [
      { directory: '/projects/alpha', project: 'alpha', worktree: null },
      { directory: '/worktrees/feature', project: 'alpha', worktree: 'feature' },
      { directory: '/projects/beta', project: 'beta', worktree: null },
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
});
