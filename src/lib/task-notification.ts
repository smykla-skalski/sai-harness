export type TaskNotification = {
  taskId: string;
  status: string;
  summary: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
};

const BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
};

function decode(value: string): string {
  return value.replace(/&(?:lt|gt|quot|apos|amp);/g, (entity) => ENTITIES[entity] ?? entity);
}

function tag(body: string, name: string): string | undefined {
  const value = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim();
  return value ? decode(value) : undefined;
}

function count(value: string | undefined): number | undefined {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

function parseBlock(block: string): TaskNotification | undefined {
  // Free-form note/result text can contain tag-like strings; read fields only from the rest.
  const body = block.replace(/<(note|result)>[\s\S]*?<\/\1>/g, '');
  const taskId = tag(body, 'task-id');
  if (!taskId) return undefined;
  const usage = body.match(/<usage>([\s\S]*?)<\/usage>/)?.[1] ?? '';
  return {
    taskId,
    status: tag(body, 'status') ?? 'unknown',
    summary: tag(body, 'summary') ?? 'Subagent update',
    tokens: count(tag(usage, 'subagent_tokens')),
    toolUses: count(tag(usage, 'tool_uses')),
    durationMs: count(tag(usage, 'duration_ms')),
  };
}

export function parseTaskNotifications(text: string): {
  notifications: TaskNotification[];
  rest: string;
} {
  if (!text.includes('<task-notification>')) return { notifications: [], rest: text };
  const notifications: TaskNotification[] = [];
  const rest = text.replace(BLOCK, (block) => {
    const parsed = parseBlock(block);
    if (!parsed) return block;
    notifications.push(parsed);
    return '';
  });
  return { notifications, rest: notifications.length > 0 ? rest.trim() : text };
}

export function isFailedStatus(status: string): boolean {
  return ['failed', 'error', 'killed'].includes(status);
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
