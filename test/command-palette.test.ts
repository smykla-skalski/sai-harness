import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newestAvailableThread, searchCommandPalette } from '../src/lib/command-palette.ts';
import type { AgentAvailability, AgentThread } from '../src/lib/acp.ts';
import type { ProjectCatalog } from '../src/lib/projects.ts';

const catalog: ProjectCatalog = {
  repositories: ['/work/alpha', '/work/bravo'],
  groups: [],
  worktrees: { '/work/alpha': [{ path: '/work/alpha-feature', branch: 'feature' }] },
};
const agents: AgentAvailability[] = [
  { id: 'claude', name: 'Claude', binaryPath: '/bin/claude', available: true, reason: null },
  { id: 'codex', name: 'Codex', binaryPath: '/bin/codex', available: true, reason: null },
];
const threads: AgentThread[] = [
  { agent: 'claude', directory: '/work/alpha', sessionId: 'a', title: 'Design panes', updated: 2 },
  { agent: 'codex', directory: '/work/bravo', sessionId: 'b', title: 'Fix tests', updated: 3 },
];

void test('palette fuzzy matches locations and thread titles', () => {
  const worktree = searchCommandPalette(catalog, threads, agents, '/work/alpha', 'ftr');
  assert.equal(worktree[0]?.directory, '/work/alpha-feature');
  const title = searchCommandPalette(catalog, threads, agents, '/work/alpha', 'dsgn');
  assert.equal(title[0]?.thread?.sessionId, 'a');
});

void test('agent term filters threads and keeps empty locations available', () => {
  const matches = searchCommandPalette(catalog, threads, agents, '/work/alpha', 'codex');
  assert.ok(
    matches.some((entry) => entry.directory === '/work/alpha-feature' && entry.agent === 'codex'),
  );
  assert.ok(matches.some((entry) => entry.thread?.sessionId === 'b'));
  assert.ok(!matches.some((entry) => entry.thread?.sessionId === 'a'));
  assert.deepEqual(searchCommandPalette(catalog, threads, agents, '/work/alpha', 'no-match'), []);
});

void test('location picks newest thread with an available agent', () => {
  const withUnavailable = [
    ...threads,
    { agent: 'ghost', directory: '/work/bravo', sessionId: 'ghost', title: 'Ghost', updated: 9 },
  ];
  assert.equal(newestAvailableThread(withUnavailable, agents, '/work/bravo', null)?.sessionId, 'b');
  assert.equal(newestAvailableThread(withUnavailable, agents, '/work/alpha-feature', null), null);
  assert.equal(newestAvailableThread(withUnavailable, agents, '/work/bravo', 'claude'), null);
});
