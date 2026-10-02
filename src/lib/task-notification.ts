export type TaskNotification = {
  taskId: string;
  status: string;
  summary: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
};

const BLOCK = /^\s*<task-notification>([\s\S]*?)<\/task-notification>\s*$/;

function tag(body: string, name: string): string | undefined {
  return body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim();
}

function count(value: string | undefined): number | undefined {
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseTaskNotification(text: string): TaskNotification | undefined {
  const body = text.match(BLOCK)?.[1];
  if (body === undefined) return undefined;
  const taskId = tag(body, 'task-id');
  if (!taskId) return undefined;
  return {
    taskId,
    status: tag(body, 'status') ?? 'unknown',
    summary: tag(body, 'summary') ?? 'Subagent update',
    tokens: count(tag(body, 'subagent_tokens')),
    toolUses: count(tag(body, 'tool_uses')),
    durationMs: count(tag(body, 'duration_ms')),
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function notificationStats(notification: TaskNotification): string[] {
  const { tokens, toolUses, durationMs } = notification;
  return [
    tokens === undefined ? '' : `${tokens.toLocaleString('en-US')} tokens`,
    toolUses === undefined ? '' : `${toolUses} ${toolUses === 1 ? 'tool use' : 'tool uses'}`,
    durationMs === undefined ? '' : formatDuration(durationMs),
  ].filter(Boolean);
}
