import type { AgentThread } from './acp';

export function threadKey(thread: AgentThread): string {
  return JSON.stringify([thread.agent, thread.directory, thread.sessionId]);
}

export function loadRecentThreadKeys(raw: string | null, threads: AgentThread[]): string[] {
  const available = new Set(threads.map(threadKey));
  if (raw === null) return threads.toSorted((a, b) => b.updated - a.updated).map(threadKey);
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(
        value.filter((key): key is string => typeof key === 'string' && available.has(key)),
      ),
    ];
  } catch {
    return [];
  }
}

export function touchRecentThread(keys: string[], thread: AgentThread): string[] {
  const key = threadKey(thread);
  return [key, ...keys.filter((item) => item !== key)];
}

export function retainRecentThreads(keys: string[], threads: AgentThread[]): string[] {
  const available = new Set(threads.map(threadKey));
  return keys.filter((key) => available.has(key));
}

export function migrateRecentThreadKeys(
  keys: string[],
  threads: AgentThread[],
  from: string,
  to: string,
): string[] {
  const replacements = new Map(
    threads
      .filter((thread) => thread.directory === from)
      .map((thread) => [threadKey(thread), threadKey({ ...thread, directory: to })]),
  );
  return [...new Set(keys.map((key) => replacements.get(key) ?? key))];
}

export function nextRecentIndex(keys: string[], current: string | null, direction: 1 | -1): number {
  if (!keys.length) return -1;
  const index = current ? keys.indexOf(current) : -1;
  if (index < 0) return direction === 1 ? 0 : keys.length - 1;
  return (index + direction + keys.length) % keys.length;
}
