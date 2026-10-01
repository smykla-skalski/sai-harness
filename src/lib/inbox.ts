import type { ProjectCatalog } from './projects';

export type InboxLocation = {
  directory: string;
  project: string;
  worktree: string | null;
};

export type InboxItem = InboxLocation & {
  key: string;
  kind: 'acp-permission' | 'opencode-permission' | 'question';
  agent: string;
  agentId?: string;
  sessionId: string;
  requestId: string | number;
  text: string;
  receivedAt: number;
  options?: { optionId: string; name: string; kind: string }[];
};

export const maxInboxSeen = 256;

function projectName(path: string): string {
  return path.split(/[\\/]/).findLast((part) => !!part) ?? path;
}

export function inboxLocations(catalog: ProjectCatalog): InboxLocation[] {
  return catalog.repositories.flatMap((repository) => [
    {
      directory: repository,
      project: projectName(repository),
      worktree: null,
    },
    ...(catalog.worktrees[repository] ?? []).map((worktree) => ({
      directory: worktree.path,
      project: projectName(repository),
      worktree: worktree.branch,
    })),
  ]);
}

export function sortInbox(items: InboxItem[]): InboxItem[] {
  return items.toSorted(
    (left, right) => left.receivedAt - right.receivedAt || left.key.localeCompare(right.key),
  );
}

export function openCodeRequestTime(id: string, now = Date.now()): number | null {
  const match = /^(?:per|frm)_([0-9a-f]{12})[0-9A-Za-z]{14}$/.exec(id);
  if (!match) return null;
  const cycle = 2 ** 36;
  const timeInCycle = Math.floor(Number.parseInt(match[1], 16) / 4096);
  let timestamp = Math.floor(now / cycle) * cycle + timeInCycle;
  if (timestamp > now) timestamp -= cycle;
  return timestamp;
}

export function loadInboxSeen(raw: string | null): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, number] => {
          const [key, value] = entry;
          return (
            key.length > 0 &&
            typeof value === 'number' &&
            Number.isFinite(value) &&
            openCodeRequestTime(key.slice(key.lastIndexOf(':') + 1)) === null
          );
        })
        .toSorted((left, right) => right[1] - left[1])
        .slice(0, maxInboxSeen),
    );
  } catch {
    return {};
  }
}
