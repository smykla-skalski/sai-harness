import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjacentPaneId,
  browserPopIndex,
  closePane,
  leaves,
  loadPaneLayouts,
  mainPane,
  migratePaneDirectory,
  paneRatioBounds,
  clampPaneRatio,
  splitPane,
  updatePane,
  withoutSideChats,
} from '../src/lib/panes.ts';

void test('browser pop history selects duplicate URLs in travel direction', () => {
  const history = ['https://example.com/a', 'https://example.com/b', 'https://example.com/a'];
  assert.equal(browserPopIndex(history, 2, history[1], -1), 1);
  assert.equal(browserPopIndex(history, 1, history[0], -1), 0);
  assert.equal(browserPopIndex(history, 0, history[1], 1), 1);
  assert.equal(browserPopIndex(history, 1, history[2], 1), 2);
});

void test('split ratios keep both panes usable at narrow sizes', () => {
  const bounds = paneRatioBounds(370);
  assert.equal(Math.round(370 * bounds.min), 120);
  assert.equal(Math.round(370 - 8 - 370 * bounds.max), 120);
  assert.equal(clampPaneRatio(0.9, 370), bounds.max);
  const threshold = paneRatioBounds(248);
  assert.equal(threshold.min, threshold.max);
  assert.equal(Math.round(248 * threshold.min), 120);
  assert.equal(Math.round(248 - 8 - 248 * threshold.max), 120);
  const narrow = paneRatioBounds(240);
  assert.equal(narrow.min, narrow.max);
  assert.equal(Math.round(240 * narrow.min), 116);
});

void test('arrow navigation follows neighboring panes without wrapping', () => {
  const panes = [
    { id: 'main', left: 0, right: 500, top: 0, bottom: 600 },
    { id: 'top', left: 504, right: 1000, top: 0, bottom: 298 },
    { id: 'bottom', left: 504, right: 1000, top: 302, bottom: 600 },
  ];
  assert.equal(adjacentPaneId(panes, 'main', 'right'), 'top');
  assert.equal(adjacentPaneId(panes, 'bottom', 'left'), 'main');
  assert.equal(adjacentPaneId(panes, 'top', 'down'), 'bottom');
  assert.equal(adjacentPaneId(panes, 'top', 'right'), null);
  assert.equal(adjacentPaneId(panes, 'main', 'up'), null);
});

void test('split and close preserve neighboring panes and their threads', () => {
  const empty = splitPane(mainPane(), 'main', 'row');
  assert.deepEqual(
    leaves(empty).map((pane) => pane.agent),
    [null, null],
  );
  const first = updatePane(empty, leaves(empty)[1].id, { agent: 'claude' });
  const created = leaves(first)[1];
  const thread = {
    agent: 'claude',
    sessionId: 'session-1',
    directory: '/repo/worktree',
    title: 'Work',
    updated: 1,
  };
  const populated = updatePane(first, created.id, { thread });
  const resized = updatePane(populated, populated.id, { ratio: 0.7 });
  assert.equal('direction' in resized && resized.ratio, 0.7);
  const secondEmpty = splitPane(resized, created.id, 'column');
  const second = updatePane(secondEmpty, leaves(secondEmpty)[2].id, { agent: 'codex' });
  assert.deepEqual(
    leaves(second).map((pane) => pane.agent),
    [null, 'claude', 'codex'],
  );
  assert.deepEqual(leaves(second)[1].thread, thread);
  assert.deepEqual(
    leaves(closePane(second, created.id)).map((pane) => pane.agent),
    [null, 'codex'],
  );
  assert.deepEqual(
    leaves(closePane(first, created.id)).map((pane) => pane.id),
    ['main'],
  );
});

void test('pane layouts survive serialization and reject malformed saved trees', () => {
  const layout = splitPane(mainPane(), 'main', 'column');
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': layout }))['/repo'], layout);
  const terminal = updatePane(layout, leaves(layout)[1].id, { kind: 'terminal' });
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': terminal }))['/repo'], terminal);
  const browserTab = { id: 'tab-1', history: ['http://localhost:3000/'], index: 0 };
  const browser = updatePane(layout, leaves(layout)[1].id, {
    kind: 'browser',
    tabs: [browserTab],
    activeTab: browserTab.id,
  });
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': browser }))['/repo'], browser);
  const invalidBrowser = updatePane(browser, leaves(browser)[1].id, {
    tabs: [{ ...browserTab, history: ['javascript:alert(1)'] }],
  });
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': invalidBrowser })), {});
  const hybrid = { id: 'main', kind: 'terminal', agent: 'claude', thread: null };
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': hybrid })), {});
  const mainTerminal = updatePane(mainPane(), 'main', { kind: 'terminal' });
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': mainTerminal })), {});
  const duplicate = {
    id: 'split',
    direction: 'row',
    ratio: 0.5,
    first: { id: 'main', agent: null, thread: null },
    second: { id: 'main', agent: 'claude', thread: null },
  };
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': duplicate })), {});
  const invalidDirection = {
    id: 'main',
    direction: 'diagonal',
    agent: 'claude',
    thread: null,
  };
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': invalidDirection })), {});
  assert.deepEqual(loadPaneLayouts('{invalid'), {});
});

void test('side chats disappear from saved layouts without losing adjacent threads', () => {
  const first = splitPane(mainPane(), 'main', 'row');
  const thread = {
    agent: 'claude',
    sessionId: 'parent',
    directory: '/repo',
    title: 'Parent',
    updated: 1,
  };
  const withThread = updatePane(first, leaves(first)[1].id, { agent: 'claude', thread });
  const second = splitPane(withThread, leaves(withThread)[1].id, 'row');
  const side = updatePane(second, leaves(second)[2].id, {
    kind: 'side-chat',
    source: { kind: 'acp', agent: 'claude', context: 'private context' },
  });
  const saved = withoutSideChats(side);
  assert.deepEqual(
    leaves(saved).map((pane) => pane.id),
    leaves(withThread).map((pane) => pane.id),
  );
  assert.deepEqual(leaves(saved)[1].thread, thread);
  assert.equal(JSON.stringify(saved).includes('private context'), false);
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': saved }))['/repo'], saved);
});

void test('canonical path migration updates threads inside nested panes', () => {
  const first = splitPane(mainPane(), 'main', 'row');
  const second = splitPane(first, leaves(first)[1].id, 'column');
  const oldThread = {
    agent: 'codex',
    sessionId: 'session-1',
    directory: '/old/repo',
    title: 'Work',
    updated: 1,
  };
  const populated = updatePane(second, leaves(second)[2].id, { thread: oldThread });
  const migrated = migratePaneDirectory(populated, '/old/repo', '/new/repo');
  assert.equal(leaves(migrated)[2].thread?.directory, '/new/repo');
  assert.equal(leaves(populated)[2].thread?.directory, '/old/repo');
});
