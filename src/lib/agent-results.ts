export type SpawnState =
  | 'queued'
  | 'starting'
  | 'working'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unavailable';

export type SpawnReceipt = {
  receiptId: string;
  accessKey: string;
  requestId: string;
  project: string;
  sourceId: string;
  sourceDirectory: string;
  targetId: string | null;
  turnId: string | null;
  targetDirectory: string | null;
  worktreeId: string | null;
  provider: 'claude' | 'codex' | 'opencode';
  prompt: string | null;
  state: SpawnState;
  created: number;
  updated: number;
  result: string | null;
  error: string | null;
};

const states = new Set<SpawnState>([
  'queued',
  'starting',
  'working',
  'waiting',
  'completed',
  'failed',
  'interrupted',
  'unavailable',
]);

export function loadSpawnReceipts(raw: string | null): SpawnReceipt[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    const receipts: SpawnReceipt[] = value.filter(
      (item): item is SpawnReceipt =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.receiptId === 'string' &&
        typeof item.accessKey === 'string' &&
        typeof item.requestId === 'string' &&
        typeof item.project === 'string' &&
        typeof item.sourceId === 'string' &&
        typeof item.sourceDirectory === 'string' &&
        (item.targetId === null || typeof item.targetId === 'string') &&
        (item.turnId === null || typeof item.turnId === 'string') &&
        (item.targetDirectory === null || typeof item.targetDirectory === 'string') &&
        (item.worktreeId === null || typeof item.worktreeId === 'string') &&
        ['claude', 'codex', 'opencode'].includes(String(item.provider)) &&
        (item.prompt === null || typeof item.prompt === 'string') &&
        states.has(item.state) &&
        typeof item.created === 'number' &&
        typeof item.updated === 'number' &&
        (item.result === null || typeof item.result === 'string') &&
        (item.error === null || typeof item.error === 'string'),
    );
    return receipts;
  } catch {
    return [];
  }
}

export function saveBoundedReceipt(
  receipts: SpawnReceipt[],
  receipt: SpawnReceipt,
): SpawnReceipt[] {
  const bounded = {
    ...receipt,
    result: receipt.result?.slice(-16_000) ?? null,
    error: receipt.error?.slice(0, 2_000) ?? null,
  };
  return [bounded, ...receipts.filter((item) => item.receiptId !== receipt.receiptId)].slice(
    0,
    200,
  );
}

export function receiptForSource(
  receipts: SpawnReceipt[],
  receiptId: string,
  accessKey: string,
  project: string,
  sourceId: string,
  sourceDirectory: string,
): SpawnReceipt | null {
  return (
    receipts.find(
      (item) =>
        item.receiptId === receiptId &&
        item.accessKey === accessKey &&
        item.project === project &&
        item.sourceId === sourceId &&
        item.sourceDirectory === sourceDirectory,
    ) ?? null
  );
}

export function receiptIsSettled(state: SpawnState): boolean {
  return ['completed', 'failed', 'interrupted', 'unavailable'].includes(state);
}

export function acpReceiptState(receipt: SpawnReceipt, activity: AgentActivity | null): SpawnState {
  if (!receipt.targetId || !receipt.turnId || !activity) return 'unavailable';
  const sessionId = receipt.targetId.slice(`acp:${receipt.provider}:`.length);
  if (
    activity.alive &&
    activity.sessions.includes(sessionId) &&
    activity.activeTurns[sessionId] === receipt.turnId
  )
    return activity.waiting.includes(sessionId) ? 'waiting' : 'working';
  const finished = activity.finished[sessionId];
  if (finished?.turnId !== receipt.turnId) return 'unavailable';
  if (finished.status === 'failed') return 'failed';
  return finished.notify ? 'completed' : 'interrupted';
}
import type { AgentActivity } from './acp';
