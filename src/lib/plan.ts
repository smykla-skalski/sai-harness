import { z } from 'zod';
import type { JsonValue, OpenCodeClient } from '@opencode/client';

const PlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  rationale: z.string().optional(),
  files: z.array(z.string()),
  risk: z.enum(['low', 'medium', 'high']),
  diagram: z.string().optional(),
  needsYou: z.string().optional(),
  status: z.string(),
  comment: z.string().optional(),
});

const PlanSchema = z.object({
  title: z.string(),
  summary: z.string(),
  diagram: z.string().optional(),
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

export async function reviewPlan(
  client: OpenCodeClient,
  directory: string,
  plan: Plan,
  action: 'revise' | 'execute',
  decisions: PlanDecision[],
  note?: string,
): Promise<void> {
  const input: JsonValue = {
    sessionID: plan.sessionID,
    version: plan.version,
    action,
    decisions: decisions.map((decision) => ({
      stepID: decision.stepID,
      ...(decision.verdict ? { verdict: decision.verdict } : {}),
      ...(decision.comment === undefined ? {} : { comment: decision.comment }),
    })),
    ...(note === undefined ? {} : { note }),
  };
  const result = OutcomeSchema.parse(await call(client, directory, 'review', input));
  if (!result.ok) throw new Error(result.error ?? 'The review was not accepted.');
}
