import type { AgentAvailability, AgentId, AgentThread } from './acp';
import type { ProjectCatalog } from './projects';
import { commandsForDirectory, type SavedCommand } from './saved-commands.ts';

export type PaletteEntry = {
  id: string;
  kind: 'location' | 'thread' | 'command';
  directory: string;
  label: string;
  detail: string;
  agent: AgentId | null;
  thread: AgentThread | null;
  command?: SavedCommand;
};

export function newestAvailableThread(
  threads: AgentThread[],
  agents: AgentAvailability[],
  directory: string,
  agentId: AgentId | null,
): AgentThread | null {
  return (
    threads
      .filter(
        (thread) =>
          thread.directory === directory &&
          (!agentId || thread.agent === agentId) &&
          agents.some((agent) => agent.id === thread.agent && agent.available),
      )
      .toSorted((a, b) => b.updated - a.updated)[0] ?? null
  );
}

function name(path: string): string {
  return path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;
}

function fuzzyScore(text: string, query: string): number | null {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return direct;
  let previous = -1;
  let score = 0;
  for (const character of needle) {
    const index = haystack.indexOf(character, previous + 1);
    if (index < 0) return null;
    score += index - previous - 1;
    previous = index;
  }
  return score;
}

export function searchCommandPalette(
  catalog: ProjectCatalog,
  threads: AgentThread[],
  agents: AgentAvailability[],
  currentDirectory: string,
  query: string,
  commands: SavedCommand[] = [],
): PaletteEntry[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const selectedAgent = agents.find(
    (agent) => agent.available && terms.some((term) => agentMatches(agent, term)),
  );
  const searchTerms = selectedAgent
    ? terms.filter((term) => !agentMatches(selectedAgent, term))
    : terms;
  const locations = catalog.repositories.flatMap((repository) => [
    { directory: repository, label: name(repository), detail: repository },
    ...(catalog.worktrees[repository] ?? []).map((worktree) => ({
      directory: worktree.path,
      label: worktree.branch,
      detail: `${name(repository)} · ${worktree.path}`,
    })),
  ]);
  const seen = new Set<string>();
  const candidates: { entry: PaletteEntry; score: number }[] = [];
  for (const location of locations) {
    if (seen.has(location.directory)) continue;
    seen.add(location.directory);
    const score = searchTerms.reduce<number | null>((total, term) => {
      const match = fuzzyScore(`${location.label} ${location.detail}`, term);
      return total === null || match === null ? null : total + match;
    }, 0);
    if (score !== null)
      candidates.push({
        entry: {
          id: `location:${location.directory}`,
          kind: 'location',
          directory: location.directory,
          label: location.label,
          detail: location.detail,
          agent: selectedAgent?.id ?? null,
          thread: null,
        },
        score: score + (location.directory === currentDirectory ? -2 : 0),
      });
  }
  for (const thread of threads) {
    if (!agents.some((agent) => agent.id === thread.agent && agent.available)) continue;
    if (selectedAgent && thread.agent !== selectedAgent.id) continue;
    const location = locations.find((item) => item.directory === thread.directory);
    if (!location) continue;
    const score = searchTerms.reduce<number | null>((total, term) => {
      const match = fuzzyScore(`${thread.title} ${location.label} ${location.detail}`, term);
      return total === null || match === null ? null : total + match;
    }, 0);
    if (score !== null)
      candidates.push({
        entry: {
          id: `thread:${thread.agent}:${thread.directory}:${thread.sessionId}`,
          kind: 'thread',
          directory: thread.directory,
          label: thread.title,
          detail: `${location.label} · ${thread.agent}`,
          agent: thread.agent,
          thread,
        },
        score: score + (thread.directory === currentDirectory ? -1 : 0),
      });
  }
  if (!selectedAgent) {
    for (const command of commandsForDirectory(commands, catalog, currentDirectory)) {
      const score = searchTerms.reduce<number | null>((total, term) => {
        const match = fuzzyScore(`${command.name} ${command.command}`, term);
        return total === null || match === null ? null : total + match;
      }, 0);
      if (score !== null)
        candidates.push({
          entry: {
            id: `command:${command.id}`,
            kind: 'command',
            directory: currentDirectory,
            label: command.name,
            detail: command.project ? 'Project command' : 'Global command',
            agent: null,
            thread: null,
            command,
          },
          score: score - 3,
        });
    }
  }
  return candidates
    .toSorted(
      (a, b) =>
        a.score - b.score || Number(a.entry.kind === 'thread') - Number(b.entry.kind === 'thread'),
    )
    .slice(0, 30)
    .map(({ entry }) => entry);
}

function agentMatches(agent: AgentAvailability, term: string): boolean {
  return agent.id.toLowerCase() === term || agent.name.toLowerCase() === term;
}
