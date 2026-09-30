import { z } from 'zod';
import type { JsonValue, OpenCodeClient } from '@opencode/client';

const PlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  rationale: z.string().optional(),
  files: z.array(z.string()),
  risk: z.enum(['low', 'medium', 'high']),
  dependsOn: z.array(z.string()).optional(),
  diagram: z.string().optional(),
  needsYou: z.string().optional(),
  status: z.enum([
    'proposed',
    'approved',
    'rejected',
    'revise',
    'in_progress',
    'done',
    'blocked',
    'skipped',
  ]),
  comment: z.string().optional(),
  note: z.string().optional(),
  origin: z.enum(['plan', 'amendment']).default('plan'),
  touched: z.array(z.string()).default([]),
  check: z
    .object({
      outcome: z.enum(['pass', 'fail', 'none']),
      summary: z.string(),
      command: z.string().optional(),
    })
    .optional(),
});

const PlanSchema = z.object({
  title: z.string(),
  summary: z.string(),
  diagram: z.string().optional(),
  sequence: z.string().optional(),
  diagrams: z.array(z.object({ title: z.string(), source: z.string() })).optional(),
  alternatives: z
    .array(
      z.object({
        name: z.string(),
        pros: z.array(z.string()),
        cons: z.array(z.string()),
        chosen: z.boolean(),
      }),
    )
    .optional(),
  steps: z.array(PlanStepSchema),
  sessionID: z.string(),
  version: z.number(),
  state: z.enum(['review', 'executing', 'done']),
  reviewReason: z.enum(['plan', 'amendment', 'checkpoint']).default('plan'),
  outside: z.array(z.string()).default([]),
  createdAt: z.number(),
});

const PlanQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  kind: z.enum(['text', 'single', 'multi', 'confirm']),
  options: z
    .array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() }))
    .optional(),
  recommended: z.array(z.string()).optional(),
});

const PlanQuestionsSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  questions: z.array(PlanQuestionSchema),
});

const PlanSnapshotSchema = z.object({
  plan: PlanSchema.nullable(),
  questions: PlanQuestionsSchema.nullable(),
});

const OutcomeSchema = z.object({ ok: z.boolean(), error: z.string().optional() });

export type Plan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanQuestion = z.infer<typeof PlanQuestionSchema>;
export type PlanQuestions = z.infer<typeof PlanQuestionsSchema>;
export type PlanSnapshot = z.infer<typeof PlanSnapshotSchema>;

export interface PlanDecision {
  stepID: string;
  verdict?: 'approve' | 'reject' | 'revise';
  comment?: string;
  edit?: { title?: string; detail?: string };
}

export function canExecutePlan(plan: Plan, decisions: Record<string, PlanDecision>): boolean {
  const status = (step: PlanStep) => {
    if (step.status === 'done' || step.status === 'skipped') return step.status;
    const decision = decisions[step.id];
    return decision?.verdict === 'approve' || (decision?.edit && !decision.verdict)
      ? 'approved'
      : decision?.verdict === 'reject' || decision?.verdict === 'revise'
        ? decision.verdict
        : step.status;
  };
  return plan.steps.some((step) => {
    const next = status(step);
    return (
      next === 'approved' ||
      next === 'in_progress' ||
      next === 'blocked' ||
      (next === 'done' && step.check?.outcome === 'fail')
    );
  });
}

export function skippedSteps(plan: Plan, decisions: Record<string, PlanDecision>): string[] {
  return plan.steps
    .filter((step) => {
      if (step.status === 'done' || step.status === 'skipped') return false;
      const decision = decisions[step.id];
      const accepted =
        decision?.verdict === 'approve' ||
        (!!decision?.edit && !decision.verdict) ||
        (!decision?.verdict &&
          !decision?.edit &&
          ['approved', 'in_progress', 'blocked'].includes(step.status));
      return !accepted;
    })
    .map((step) => step.id);
}

export function snapshotAnswers(answers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, [...values]]));
}

async function call(
  client: OpenCodeClient,
  directory: string,
  method: string,
  input: JsonValue,
): Promise<unknown> {
  const response = await client.rpc.call({
    rpcID: 'planreview',
    method,
    location: { directory },
    input,
  });
  return response.output;
}

export async function getPlan(
  client: OpenCodeClient,
  directory: string,
  sessionID: string,
): Promise<PlanSnapshot> {
  return PlanSnapshotSchema.parse(await call(client, directory, 'get', { sessionID }));
}

export async function answerQuestions(
  client: OpenCodeClient,
  directory: string,
  sessionID: string,
  id: string,
  answers: Record<string, string[]>,
): Promise<void> {
  const result = OutcomeSchema.parse(
    await call(client, directory, 'answer', { sessionID, id, answers }),
  );
  if (!result.ok) throw new Error(result.error ?? 'The answers were not accepted.');
}

export function reviewInput(
  plan: Plan,
  action: 'revise' | 'execute',
  decisions: PlanDecision[],
  note?: string,
): JsonValue {
  return {
    sessionID: plan.sessionID,
    version: plan.version,
    action,
    decisions: decisions.map((decision) => ({
      stepID: decision.stepID,
      ...(decision.verdict ? { verdict: decision.verdict } : {}),
      ...(decision.comment === undefined ? {} : { comment: decision.comment }),
      ...(decision.edit === undefined ? {} : { edit: decision.edit }),
    })),
    ...(note === undefined ? {} : { note }),
  };
}

export async function reviewPlan(
  client: OpenCodeClient,
  directory: string,
  plan: Plan,
  action: 'revise' | 'execute',
  decisions: PlanDecision[],
  note?: string,
): Promise<void> {
  const result = OutcomeSchema.parse(
    await call(client, directory, 'review', reviewInput(plan, action, decisions, note)),
  );
  if (!result.ok) throw new Error(result.error ?? 'The review was not accepted.');
}
