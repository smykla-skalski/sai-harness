import assert from 'node:assert/strict';
import test from 'node:test';
import { historyRows } from '../src/lib/history.ts';
import type { HistoryEntry, Plan } from '../src/lib/plan.ts';

const proposal: Plan = {
  title: 'Ship',
  summary: 'Deliver change',
  sessionID: 'session',
  version: 1,
  state: 'review',
  reviewReason: 'plan',
  outside: [],
  createdAt: 1,
  steps: [
    {
      id: 's1',
      title: 'Build',
      detail: 'Do work',
      files: ['src/a.ts'],
      risk: 'low',
      status: 'proposed',
      origin: 'plan',
      touched: [],
    },
  ],
};

await test('history rows preserve decisions and same-version execution transitions', () => {
  const approved: Plan = {
    ...proposal,
    state: 'executing',
    steps: [{ ...proposal.steps[0], status: 'approved' }],
  };
  const done: Plan = {
    ...approved,
    state: 'done',
    steps: [
      {
        ...approved.steps[0],
        status: 'done',
        touched: ['src/a.ts'],
        check: { outcome: 'pass', summary: 'Tests pass' },
      },
    ],
  };
  const events: HistoryEntry[] = [
    { id: 3, at: 3, reason: 'done', version: 1, plan: done },
    {
      id: 2,
      at: 2,
      reason: 'reviewed',
      version: 1,
      plan: approved,
      review: {
        sessionID: 'session',
        version: 1,
        action: 'execute',
        decisions: [
          { stepID: 's1', verdict: 'approve', comment: 'Safe', edit: { detail: 'Run tests' } },
        ],
        note: 'Run tests',
      },
    },
    { id: 1, at: 1, reason: 'proposed', version: 1, plan: proposal },
    { id: 2, at: 2, reason: 'reviewed', version: 1, plan: approved },
  ];
  const rows = historyRows(events);
  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 2, 3],
  );
  assert.equal(rows[1]?.title, 'Execution approved');
  assert.ok(rows[1]?.details.includes('Build: approve — Safe'));
  assert.ok(rows[1]?.details.includes('Build detail edit: Run tests'));
  assert.ok(rows[1]?.details.includes('Review note: Run tests'));
  assert.ok(rows[2]?.details.includes('Check pass: Tests pass'));
  assert.ok(rows[2]?.details.includes('Touched: src/a.ts'));
});

await test('new plan version shows revisions to existing steps', () => {
  const revised: Plan = {
    ...proposal,
    version: 2,
    summary: 'Safer delivery',
    steps: [
      { ...proposal.steps[0], detail: 'Run verification', files: ['src/b.ts'], risk: 'high' },
    ],
  };
  const rows = historyRows([
    { id: 1, at: 1, reason: 'proposed', version: 1, plan: proposal },
    { id: 2, at: 2, reason: 'proposed', version: 2, plan: revised },
  ]);
  assert.ok(rows[1]?.details.includes('Summary revised: Safer delivery'));
  assert.ok(rows[1]?.details.includes('Build detail revised: Run verification'));
  assert.ok(rows[1]?.details.includes('Build files revised: src/b.ts'));
  assert.ok(rows[1]?.details.includes('Build risk revised: high'));
});
