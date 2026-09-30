import assert from 'node:assert/strict';
import test from 'node:test';
import { canExecutePlan, reviewInput, skippedSteps, type Plan } from '../src/lib/plan.ts';

const plan: Plan = {
  title: 'Plan',
  summary: 'Summary',
  steps: [
    {
      id: 's1',
      title: 'First',
      detail: 'Detail',
      files: [],
      risk: 'low',
      status: 'proposed',
      origin: 'plan',
      touched: [],
    },
    {
      id: 's2',
      title: 'Second',
      detail: 'Detail',
      files: [],
      risk: 'low',
      status: 'proposed',
      origin: 'plan',
      touched: [],
    },
    {
      id: 's3',
      title: 'Completed',
      detail: 'Detail',
      files: [],
      risk: 'low',
      status: 'done',
      origin: 'plan',
      touched: [],
    },
  ],
  sessionID: 'session',
  version: 2,
  state: 'review',
  reviewReason: 'plan',
  outside: [],
  createdAt: 1,
};

await test('execution requires unfinished approved work and lists skipped steps', () => {
  assert.equal(canExecutePlan(plan, {}), false);
  const decisions = { s1: { stepID: 's1', edit: { title: 'Changed' } } };
  assert.equal(canExecutePlan(plan, decisions), true);
  assert.deepEqual(skippedSteps(plan, decisions), ['s2']);
  assert.equal(canExecutePlan(plan, { s1: { stepID: 's1', verdict: 'reject' } }), false);
});

await test('review RPC input includes version, edit, comments, and action', () => {
  const input = reviewInput(
    plan,
    'revise',
    [{ stepID: 's1', verdict: 'approve', edit: { title: 'Changed' }, comment: 'Reason' }],
    'Please revise s2',
  );

  assert.deepEqual(input, {
    sessionID: 'session',
    version: 2,
    action: 'revise',
    decisions: [
      { stepID: 's1', verdict: 'approve', comment: 'Reason', edit: { title: 'Changed' } },
    ],
    note: 'Please revise s2',
  });
});
