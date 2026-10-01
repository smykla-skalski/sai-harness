import { invoke } from '@tauri-apps/api/core';

export type AgentId = string;

export interface AgentAvailability {
  id: AgentId;
  name: string;
  binaryPath: string | null;
  available: boolean;
  reason: string | null;
}

export interface AgentThread {
  agent: AgentId;
  sessionId: string;
  directory: string;
  title: string;
  updated: number;
}

export interface AgentMessage {
  id: string;
  type: 'user' | 'assistant' | 'thought';
  text: string;
}

export interface AgentTool {
  id: string;
  type: 'tool';
  title: string;
  status: string;
  content: string;
}

export type AgentEntry = AgentMessage | AgentTool;

export interface AgentPermission {
  id: string | number;
  sessionId: string;
  title: string;
  options: { optionId: string; name: string; kind: string }[];
}

export interface AgentConfigOption {
  id: string;
  name: string;
  type: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

export interface AgentAuthMethod {
  id: string;
  name: string;
  type?: string;
}

export interface AgentEvent {
  agent: AgentId;
  message: {
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
  };
}

const storageKey = 'sail-agent-threads';

export function loadAgentThreads(): AgentThread[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is AgentThread =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.agent === 'string' &&
        item.agent.length > 0 &&
        typeof item.sessionId === 'string' &&
        typeof item.directory === 'string' &&
        typeof item.title === 'string' &&
        typeof item.updated === 'number',
    );
  } catch {
    return [];
  }
}

export function saveAgentThreads(threads: AgentThread[]): void {
  localStorage.setItem(storageKey, JSON.stringify(threads));
}

export function updateEntries(
  entries: AgentEntry[],
  update: Record<string, unknown>,
): AgentEntry[] {
  const type = update.sessionUpdate;
  if (
    type === 'agent_message_chunk' ||
    type === 'user_message_chunk' ||
    type === 'agent_thought_chunk'
  ) {
    const block = update.content;
    if (!block || typeof block !== 'object' || !('text' in block) || typeof block.text !== 'string')
      return entries;
    const role =
      type === 'user_message_chunk'
        ? 'user'
        : type === 'agent_thought_chunk'
          ? 'thought'
          : 'assistant';
    const last = entries.at(-1);
    if (last?.type === role) {
      return [...entries.slice(0, -1), { ...last, text: last.text + block.text }];
    }
    return [...entries, { id: crypto.randomUUID(), type: role, text: block.text }];
  }
  if (type === 'tool_call' || type === 'tool_call_update') {
    const id = update.toolCallId;
    if (typeof id !== 'string') return entries;
    const existing = entries.find(
      (entry): entry is AgentTool => entry.type === 'tool' && entry.id === id,
    );
    const content = Array.isArray(update.content)
      ? update.content
          .map((item) => {
            if (!item || typeof item !== 'object' || !('content' in item)) return '';
            const block = item.content;
            return block &&
              typeof block === 'object' &&
              'text' in block &&
              typeof block.text === 'string'
              ? block.text
              : '';
          })
          .filter(Boolean)
          .join('\n')
      : (existing?.content ?? '');
    const next: AgentTool = {
      id,
      type: 'tool',
      title: typeof update.title === 'string' ? update.title : (existing?.title ?? 'Tool call'),
      status: typeof update.status === 'string' ? update.status : (existing?.status ?? 'pending'),
      content,
    };
    return existing
      ? entries.map((entry) => (entry.type === 'tool' && entry.id === id ? next : entry))
      : [...entries, next];
  }
  return entries;
}

export const acp = {
  agents: () => invoke<AgentAvailability[]>('acp_agents'),
  connect: (agent: AgentId) => invoke<Record<string, unknown>>('acp_connect', { agent }),
  create: (agent: AgentId, cwd: string) =>
    invoke<{ sessionId: string; configOptions?: AgentConfigOption[] }>('acp_new_session', {
      agent,
      cwd,
    }),
  load: (agent: AgentId, cwd: string, sessionId: string) =>
    invoke<Record<string, unknown>>('acp_load_session', { agent, cwd, sessionId }),
  prompt: (agent: AgentId, sessionId: string, text: string) =>
    invoke<{ stopReason: string }>('acp_prompt', { agent, sessionId, text }),
  cancel: (agent: AgentId, sessionId: string) => invoke<void>('acp_cancel', { agent, sessionId }),
  permission: (agent: AgentId, requestId: string | number, optionId: string | null) =>
    invoke<void>('acp_permission', { agent, requestId, optionId }),
  pendingPermissions: (agent: AgentId, sessionId: string) =>
    invoke<AgentEvent['message'][]>('acp_pending_permissions', { agent, sessionId }),
  setConfig: (agent: AgentId, sessionId: string, configId: string, value: string) =>
    invoke<{ configOptions?: AgentConfigOption[] }>('acp_set_config', {
      agent,
      sessionId,
      configId,
      value,
    }),
  authenticate: (agent: AgentId, methodId: string) =>
    invoke<Record<string, unknown>>('acp_authenticate', { agent, methodId }),
};
