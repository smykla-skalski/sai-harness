import type { AgentThread } from './acp';
import type { ThreadStatus } from './attention';
import { threadKey } from './recent-threads.ts';

export type SidebarSessionSource = {
  session: {
    list: (input: {
      directory: string;
      limit: number;
      order: 'desc';
      parentID: null;
      cursor?: string;
    }) => Promise<{
      data: {
        id: string;
        parentID?: string;
        title?: string;
        location: { directory: string };
        time: { updated: number };
        outcome?: 'succeeded' | 'failed' | 'interrupted';
      }[];
      cursor: { next?: string | null };
    }>;
  };
};

export async function listSidebarOpenCodeThreads(
  source: SidebarSessionSource,
  path: string,
  cursor?: string,
  seen = new Set<string>(),
  threads: AgentThread[] = [],
  outcomes: Record<string, ThreadStatus> = {},
): Promise<{ threads: AgentThread[]; outcomes: Record<string, ThreadStatus> }> {
  const page = await source.session.list({
    directory: path,
    limit: 100,
    order: 'desc',
    parentID: null,
    ...(cursor ? { cursor } : {}),
  });
  for (const session of page.data) {
    if (session.location.directory !== path || session.parentID) continue;
    const thread: AgentThread = {
      agent: 'opencode',
      directory: path,
      sessionId: session.id,
      title: session.title ?? 'Untitled session',
      updated: session.time.updated,
    };
    threads.push(thread);
    if (session.outcome)
      outcomes[threadKey(thread)] = session.outcome === 'failed' ? 'failed' : 'done';
  }
  const next = page.cursor.next ?? undefined;
  if (!next || next === cursor || seen.has(next)) return { threads, outcomes };
  seen.add(next);
  return listSidebarOpenCodeThreads(source, path, next, seen, threads, outcomes);
}

export function groupSidebarThreads(threads: AgentThread[]): Record<string, AgentThread[]> {
  const unique = new Map<string, AgentThread>();
  for (const thread of threads) {
    const key = threadKey(thread);
    const previous = unique.get(key);
    if (!previous || previous.updated < thread.updated) unique.set(key, thread);
  }
  const grouped: Record<string, AgentThread[]> = {};
  for (const thread of unique.values()) (grouped[thread.directory] ??= []).push(thread);
  for (const items of Object.values(grouped)) items.sort((a, b) => b.updated - a.updated);
  return grouped;
}
