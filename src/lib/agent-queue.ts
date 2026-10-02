import type { BrowserAttachment } from './browser-pick';

export interface QueuedAgentMessage {
  text: string;
  images: BrowserAttachment[];
  attachments: { path: string; name: string; image: boolean }[];
}

const queues = new Map<string, QueuedAgentMessage[]>();
const paused = new Set<string>();

export function queuedAgentMessages(
  agent: string,
  directory: string,
  sessionId: string,
): QueuedAgentMessage[] {
  return queues.get(JSON.stringify([agent, directory, sessionId])) ?? [];
}

export function saveQueuedAgentMessages(
  agent: string,
  directory: string,
  sessionId: string,
  messages: QueuedAgentMessage[],
): void {
  const key = JSON.stringify([agent, directory, sessionId]);
  if (messages.length) queues.set(key, messages);
  else queues.delete(key);
}

export function agentQueuePaused(agent: string, directory: string, sessionId: string): boolean {
  return paused.has(JSON.stringify([agent, directory, sessionId]));
}

export function setAgentQueuePaused(
  agent: string,
  directory: string,
  sessionId: string,
  value: boolean,
): void {
  const key = JSON.stringify([agent, directory, sessionId]);
  if (value) paused.add(key);
  else paused.delete(key);
}
