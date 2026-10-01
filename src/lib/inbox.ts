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

export function inboxLocations(catalog: ProjectCatalog): InboxLocation[] {
  return catalog.repositories.flatMap((repository) => [
    {
      directory: repository,
      project: repository.split('/').findLast((part) => !!part) ?? repository,
      worktree: null,
    },
    ...(catalog.worktrees[repository] ?? []).map((worktree) => ({
      directory: worktree.path,
      project: repository.split('/').findLast((part) => !!part) ?? repository,
      worktree: worktree.branch,
    })),
  ]);
}

export function sortInbox(items: InboxItem[]): InboxItem[] {
  return items.toSorted(
    (left, right) => left.receivedAt - right.receivedAt || left.key.localeCompare(right.key),
  );
}

export function loadInboxSeen(raw: string | null): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, value]) => key.length > 0 && typeof value === 'number' && Number.isFinite(value),
      ),
    );
  } catch {
    return {};
  }
}
