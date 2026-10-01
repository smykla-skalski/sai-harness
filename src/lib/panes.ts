import type { AgentId, AgentThread } from './acp';

export type Pane =
  | { id: string; agent: AgentId | null; thread: AgentThread | null }
  | { id: string; direction: 'row' | 'column'; ratio: number; first: Pane; second: Pane };

export const mainPane = (): Pane => ({ id: 'main', agent: null, thread: null });

export type PaneBounds = {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export function adjacentPaneId(
  panes: PaneBounds[],
  focused: string,
  direction: 'left' | 'right' | 'up' | 'down',
): string | null {
  const current = panes.find((pane) => pane.id === focused);
  if (!current) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const candidates = panes
    .filter((pane) => pane.id !== focused)
    .map((pane) => {
      const gap =
        direction === 'left'
          ? current.left - pane.right
          : direction === 'right'
            ? pane.left - current.right
            : direction === 'up'
              ? current.top - pane.bottom
              : pane.top - current.bottom;
      const overlap = horizontal
        ? Math.min(current.bottom, pane.bottom) - Math.max(current.top, pane.top)
        : Math.min(current.right, pane.right) - Math.max(current.left, pane.left);
      const centerDistance = horizontal
        ? Math.abs((current.top + current.bottom - pane.top - pane.bottom) / 2)
        : Math.abs((current.left + current.right - pane.left - pane.right) / 2);
      return { id: pane.id, gap, overlap, centerDistance };
    })
    .filter((pane) => pane.gap >= -1 && pane.overlap > 0)
    .toSorted((a, b) => a.gap - b.gap || a.centerDistance - b.centerDistance);
  return candidates[0]?.id ?? null;
}

export function leaves(pane: Pane): Extract<Pane, { agent: AgentId | null }>[] {
  return 'direction' in pane ? [...leaves(pane.first), ...leaves(pane.second)] : [pane];
}

export function splitPane(
  pane: Pane,
  id: string,
  direction: 'row' | 'column',
  agent: AgentId,
): Pane {
  if ('direction' in pane)
    return {
      ...pane,
      first: splitPane(pane.first, id, direction, agent),
      second: splitPane(pane.second, id, direction, agent),
    };
  if (pane.id !== id) return pane;
  return {
    id: crypto.randomUUID(),
    direction,
    ratio: 0.5,
    first: pane,
    second: { id: crypto.randomUUID(), agent, thread: null },
  };
}

export function closePane(pane: Pane, id: string): Pane {
  if (!('direction' in pane)) return pane.id === id ? mainPane() : pane;
  if (leaves(pane.first).some((leaf) => leaf.id === id)) {
    if (!('direction' in pane.first) && pane.first.id === id) return pane.second;
    return { ...pane, first: closePane(pane.first, id) };
  }
  if (!('direction' in pane.second) && pane.second.id === id) return pane.first;
  return { ...pane, second: closePane(pane.second, id) };
}

export function updatePane(pane: Pane, id: string, update: Partial<Pane>): Pane {
  if ('direction' in pane) {
    if (pane.id === id && 'ratio' in update && typeof update.ratio === 'number')
      return { ...pane, ratio: update.ratio };
    return {
      ...pane,
      first: updatePane(pane.first, id, update),
      second: updatePane(pane.second, id, update),
    };
  }
  return pane.id === id ? { ...pane, ...update } : pane;
}

export function migratePaneDirectory(pane: Pane, from: string, to: string): Pane {
  if ('direction' in pane)
    return {
      ...pane,
      first: migratePaneDirectory(pane.first, from, to),
      second: migratePaneDirectory(pane.second, from, to),
    };
  return pane.thread?.directory === from
    ? { ...pane, thread: { ...pane.thread, directory: to } }
    : pane;
}

export function loadPaneLayouts(raw: string | null): Record<string, Pane> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, Pane] =>
          typeof entry[0] === 'string' && validPane(entry[1], new Set<string>()),
      ),
    );
  } catch {
    return {};
  }
}

function validPane(value: unknown, ids: Set<string>): value is Pane {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pane: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (typeof pane.id !== 'string' || !pane.id || ids.has(pane.id)) return false;
  ids.add(pane.id);
  if ('direction' in pane)
    return (
      (pane.direction === 'row' || pane.direction === 'column') &&
      typeof pane.ratio === 'number' &&
      Number.isFinite(pane.ratio) &&
      pane.ratio >= 0.1 &&
      pane.ratio <= 0.9 &&
      validPane(pane.first, ids) &&
      validPane(pane.second, ids)
    );
  return (
    (pane.agent === null || typeof pane.agent === 'string') &&
    (pane.thread === null ||
      (typeof pane.thread === 'object' &&
        pane.thread !== null &&
        'sessionId' in pane.thread &&
        typeof pane.thread.sessionId === 'string'))
  );
}
