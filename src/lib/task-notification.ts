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
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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

export type TaskSegment =
  { type: 'text'; text: string } | { type: 'notification'; notification: TaskNotification };

export function splitTaskNotifications(text: string): TaskSegment[] {
  if (!text.includes('<task-notification>')) return [{ type: 'text', text }];
  const segments: TaskSegment[] = [];
  let cursor = 0;
  let found = false;
  const pushText = (end: number) => {
    const chunk = text.slice(cursor, end).trim();
    if (chunk) segments.push({ type: 'text', text: chunk });
  };
  for (const match of text.matchAll(BLOCK)) {
    const notification = parseBlock(match[0]);
    if (!notification) continue;
    found = true;
    pushText(match.index);
    segments.push({ type: 'notification', notification });
    cursor = match.index + match[0].length;
  }
  if (!found) return [{ type: 'text', text }];
  pushText(text.length);
  return segments;
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
