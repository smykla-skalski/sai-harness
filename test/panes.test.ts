import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjacentPaneId,
  closePane,
  leaves,
  loadPaneLayouts,
  mainPane,
  splitPane,
  updatePane,
} from '../src/lib/panes.ts';

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
  const first = splitPane(mainPane(), 'main', 'row', 'claude');
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
  const second = splitPane(resized, created.id, 'column', 'codex');
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
  const layout = splitPane(mainPane(), 'main', 'column', 'claude');
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': layout }))['/repo'], layout);
  const duplicate = {
    id: 'split',
    direction: 'row',
    ratio: 0.5,
    first: { id: 'main', agent: null, thread: null },
    second: { id: 'main', agent: 'claude', thread: null },
  };
  assert.deepEqual(loadPaneLayouts(JSON.stringify({ '/repo': duplicate })), {});
  assert.deepEqual(loadPaneLayouts('{invalid'), {});
});
