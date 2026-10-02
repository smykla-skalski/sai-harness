import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupSidebarThreads,
  listSidebarOpenCodeThreads,
  type SidebarSessionSource,
} from '../src/lib/sidebar-agents.ts';

await test('sidebar groups every thread by checkout and keeps distinct sessions', () => {
  const grouped = groupSidebarThreads([
    { agent: 'claude', directory: '/repo/a', sessionId: 'one', title: 'Old', updated: 1 },
    { agent: 'claude', directory: '/repo/a', sessionId: 'two', title: 'Second', updated: 2 },
    { agent: 'codex', directory: '/repo/a', sessionId: 'one', title: 'Codex', updated: 3 },
    { agent: 'claude', directory: '/repo/b', sessionId: 'one', title: 'Other', updated: 4 },
    { agent: 'claude', directory: '/repo/a', sessionId: 'one', title: 'Renamed', updated: 5 },
  ]);
  assert.deepEqual(
    grouped['/repo/a'].map(({ title }) => title),
    ['Renamed', 'Codex', 'Second'],
  );
  assert.deepEqual(
    grouped['/repo/b'].map(({ title }) => title),
    ['Other'],
  );
});

await test('sidebar inventory follows every OpenCode page and excludes child and foreign sessions', async () => {
  const calls: Array<string | undefined> = [];
  const source: SidebarSessionSource = {
    session: {
      list: async ({ cursor }: { cursor?: string }) => {
        calls.push(cursor);
        return cursor
          ? {
              data: [
                {
                  id: 'second',
                  title: 'Second agent',
                  location: { directory: '/repo/a' },
                  time: { updated: 2 },
                  outcome: 'failed',
                },
                {
                  id: 'foreign',
                  location: { directory: '/repo/b' },
                  time: { updated: 3 },
                },
              ],
              cursor: { next: null },
            }
          : {
              data: [
                {
                  id: 'first',
                  location: { directory: '/repo/a' },
                  time: { updated: 1 },
                  outcome: 'succeeded',
                },
                {
                  id: 'child',
                  parentID: 'first',
                  location: { directory: '/repo/a' },
                  time: { updated: 2 },
                },
              ],
              cursor: { next: 'page-2' },
            };
      },
    },
  };
  const result = await listSidebarOpenCodeThreads(source, '/repo/a');
  assert.deepEqual(calls, [undefined, 'page-2']);
  assert.deepEqual(
    result.threads.map((thread) => thread.sessionId),
    ['first', 'second'],
  );
  assert.equal(result.threads[0].title, 'Untitled session');
  assert.deepEqual(Object.values(result.outcomes), ['done', 'failed']);
});
