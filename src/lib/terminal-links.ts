export type TerminalFileLink = { path: string; line: number; text: string; start: number };

export function terminalFileLinks(content: string): TerminalFileLink[] {
  const links: TerminalFileLink[] = [];
  const pattern =
    /(?:^|[\s('"])((?:[A-Za-z]:[\\/])?[A-Za-z0-9_./\\~-]+\.[A-Za-z0-9_-]+):(\d+)(?::\d+)?/g;
  for (const match of content.matchAll(pattern)) {
    const text = match[0].trimStart().replace(/^[('"]/, '');
    links.push({
      path: match[1],
      line: Number(match[2]),
      text,
      start: (match.index ?? 0) + match[0].length - text.length + 1,
    });
  }
  return links;
}
