import type { ProjectCatalog } from './projects';

export type SavedCommand = {
  id: string;
  name: string;
  command: string;
  project: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadSavedCommands(raw: string | null): SavedCommand[] {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): SavedCommand[] => {
    if (!isRecord(item)) return [];
    const entry = item;
    if (
      typeof entry.id !== 'string' ||
      !entry.id ||
      seen.has(entry.id) ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      typeof entry.command !== 'string' ||
      !entry.command.trim() ||
      !(entry.project === null || typeof entry.project === 'string')
    )
      return [];
    seen.add(entry.id);
    return [
      {
        id: entry.id,
        name: entry.name.trim(),
        command: entry.command,
        project: entry.project,
      },
    ];
  });
}

export function selectedRepository(catalog: ProjectCatalog, directory: string): string | null {
  return (
    catalog.repositories.find(
      (repository) =>
        repository === directory ||
        (catalog.worktrees[repository] ?? []).some((worktree) => worktree.path === directory),
    ) ?? null
  );
}

export function commandsForDirectory(
  commands: SavedCommand[],
  catalog: ProjectCatalog,
  directory: string,
): SavedCommand[] {
  const repository = selectedRepository(catalog, directory);
  return commands.filter((command) => command.project === null || command.project === repository);
}
