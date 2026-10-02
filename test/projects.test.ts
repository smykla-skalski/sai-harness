import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addWorktree,
  assignRepository,
  loadProjectCatalog,
  removeRepository,
  replaceRepositoryPath,
  setWorktreePullRequest,
  ungroupedRepositories,
} from '../src/lib/projects.ts';

await test('restores the current repository and ignores malformed saved groups', () => {
  assert.deepEqual(loadProjectCatalog('{bad', '/repo'), {
    repositories: ['/repo'],
    groups: [],
    worktrees: {},
  });
  const catalog = loadProjectCatalog(
    JSON.stringify({
      repositories: ['/first', '/first', '/second'],
      groups: [
        { id: 'one', name: 'Work', repositories: ['/first', '/missing'] },
        { id: 'two', name: 'Other', repositories: ['/first', '/second'] },
      ],
    }),
    '/current',
  );
  assert.deepEqual(catalog.repositories, ['/current', '/first', '/second']);
  assert.deepEqual(
    catalog.groups.map((group) => group.repositories),
    [['/first'], ['/second']],
  );
  assert.deepEqual(ungroupedRepositories(catalog), ['/current']);
});

await test('moves repositories between named groups without losing saved entries', () => {
  const initial = loadProjectCatalog(
    JSON.stringify({
      repositories: ['/one'],
      groups: [
        { id: 'a', name: 'Alpha', repositories: ['/one'] },
        { id: 'b', name: 'Beta', repositories: [] },
      ],
    }),
    '',
  );
  const moved = assignRepository(initial, '/one', 'b');
  assert.deepEqual(
    moved.groups.map((group) => group.repositories),
    [[], ['/one']],
  );
  assert.deepEqual(ungroupedRepositories(assignRepository(moved, '/one', null)), ['/one']);
  assert.deepEqual(removeRepository(moved, '/one').repositories, []);
});

await test('canonicalizes a saved repository without losing its group', () => {
  const catalog = loadProjectCatalog(
    JSON.stringify({
      repositories: ['/var/repo'],
      groups: [{ id: 'work', name: 'Work', repositories: ['/var/repo'] }],
    }),
    '',
  );
  const normalized = replaceRepositoryPath(catalog, '/var/repo', '/private/var/repo');
  assert.deepEqual(normalized.repositories, ['/private/var/repo']);
  assert.deepEqual(normalized.groups[0].repositories, ['/private/var/repo']);
});

await test('keeps a created worktree beneath its repository after restart', () => {
  const catalog = addWorktree(loadProjectCatalog(null, '/repo'), '/repo', {
    path: '/sail/worktrees/repo/task',
    branch: 'task',
  });
  const restored = loadProjectCatalog(JSON.stringify(catalog), '/sail/worktrees/repo/task');
  assert.deepEqual(restored.repositories, ['/repo']);
  assert.deepEqual(restored.worktrees['/repo'], [
    { path: '/sail/worktrees/repo/task', branch: 'task' },
  ]);
});

await test('keeps the worktree PR link after restart and rejects unsafe links', () => {
  const catalog = addWorktree(loadProjectCatalog(null, '/repo'), '/repo', {
    path: '/repo-pr',
    branch: 'feature',
    base: 'origin/main',
  });
  const linked = setWorktreePullRequest(catalog, '/repo', '/repo-pr', {
    number: 42,
    url: 'https://github.com/owner/repo/pull/42',
  });
  assert.deepEqual(loadProjectCatalog(JSON.stringify(linked), '/repo-pr').worktrees['/repo'], [
    linked.worktrees['/repo'][0],
  ]);
  const malformed = JSON.parse(JSON.stringify(linked));
  malformed.worktrees['/repo'][0].pullRequest.url = 'javascript:alert(1)';
  assert.equal(
    loadProjectCatalog(JSON.stringify(malformed), '/repo-pr').worktrees['/repo'][0].pullRequest,
    undefined,
  );
});
