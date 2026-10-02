import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentThread } from '../src/lib/acp.ts';
import {
  loadRecentNativeThreads,
  loadRecentThreadKeys,
  migrateRecentThreadKeys,
  nextRecentIndex,
  retainRecentThreads,
  threadKey,
  touchRecentThread,
} from '../src/lib/recent-threads.ts';

const threads: AgentThread[] = [
  { agent: 'claude', directory: '/alpha', sessionId: 'a', title: 'Alpha', updated: 1 },
  { agent: 'codex', directory: '/bravo', sessionId: 'b', title: 'Bravo', updated: 3 },
  { agent: 'claude', directory: '/charlie', sessionId: 'c', title: 'Charlie', updated: 2 },
];

void test('recent order starts from activity, then follows visits and survives reload', () => {
  const seeded = loadRecentThreadKeys(null, threads);
  assert.deepEqual(seeded, [threadKey(threads[1]), threadKey(threads[2]), threadKey(threads[0])]);
  const visited = touchRecentThread(seeded, threads[0]);
  assert.deepEqual(visited, [threadKey(threads[0]), threadKey(threads[1]), threadKey(threads[2])]);
  assert.deepEqual(loadRecentThreadKeys(JSON.stringify(visited), threads), visited);
});

void test('native OpenCode threads join recent navigation without accepting malformed entries', () => {
  const native: AgentThread = {
    agent: 'opencode',
    directory: '/alpha',
    sessionId: 'native',
    title: 'Native',
    updated: 4,
  };
  const restored = loadRecentNativeThreads(
    JSON.stringify([native, { ...native, agent: 'claude' }, { ...native, sessionId: 12 }]),
  );
  assert.deepEqual(restored, [native]);
  assert.deepEqual(loadRecentThreadKeys(null, [...threads, ...restored])[0], threadKey(native));
  assert.deepEqual(loadRecentNativeThreads('{bad'), []);
});

void test('missing threads and malformed storage cannot occupy shortcuts', () => {
  const saved = [threadKey(threads[0]), 'missing', threadKey(threads[0]), threadKey(threads[1])];
  assert.deepEqual(loadRecentThreadKeys(JSON.stringify(saved), threads), [
    threadKey(threads[0]),
    threadKey(threads[1]),
  ]);
  assert.deepEqual(retainRecentThreads(saved, [threads[1]]), [threadKey(threads[1])]);
  assert.deepEqual(loadRecentThreadKeys('{bad', threads), []);
});

void test('cycle traverses a stable order in both directions', () => {
  const keys = threads.map(threadKey);
  assert.equal(nextRecentIndex(keys, keys[0], 1), 1);
  assert.equal(nextRecentIndex(keys, keys[1], 1), 2);
  assert.equal(nextRecentIndex(keys, keys[2], 1), 0);
  assert.equal(nextRecentIndex(keys, keys[0], -1), 2);
  assert.equal(nextRecentIndex(keys, null, 1), 0);
  assert.equal(nextRecentIndex([], null, 1), -1);
});

void test('canonical project migration preserves recent order', () => {
  const keys = threads.map(threadKey);
  assert.deepEqual(migrateRecentThreadKeys(keys, threads, '/alpha', '/real/alpha'), [
    threadKey({ ...threads[0], directory: '/real/alpha' }),
    keys[1],
    keys[2],
  ]);
});
