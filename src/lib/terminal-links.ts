export type TerminalFileLink = { path: string; line: number; text: string; start: number };

export function terminalFileLinks(content: string): TerminalFileLink[] {
  const links: TerminalFileLink[] = [];
  const patterns = [
    /(["'])([^"'\r\n]+?):(\d+)(?::\d+)?\1/g,
    /(["'])([^"'\r\n]+?)\1:(\d+)(?::\d+)?/g,
    /(?:^|[\s([{])((?:[A-Za-z]:[\\/]|\/|~[\\/]|\.\.?[\\/])[^:\r\n"'<>]*?):(\d+)(?::\d+)?(?=$|[\s)\]",])/g,
    /(?:^|[\s([{])([A-Za-z0-9_.~\\/-]+(?:\\ [A-Za-z0-9_.~\\/-]+)+):(\d+)(?::\d+)?(?=$|[\s)\]",])/g,
    /(?:^|[\s([{])([A-Za-z0-9_.~\\/-]+):(\d+)(?::\d+)?(?=$|[\s)\]",])/g,
  ];
  for (const [index, pattern] of patterns.entries()) {
    for (const match of content.matchAll(pattern)) {
      const quoted = index < 2;
      const path = quoted ? match[2] : match[1];
      const line = Number(quoted ? match[3] : match[2]);
      if (!path || !Number.isSafeInteger(line) || line < 1) continue;
      const text = quoted ? match[0] : match[0].slice(match[0].indexOf(path));
      const start = (match.index ?? 0) + match[0].indexOf(text) + 1;
      const end = start + text.length - 1;
      if (links.some((link) => start <= link.start + link.text.length - 1 && end >= link.start))
        continue;
      links.push({ path: path.replace(/\\ /g, ' '), line, text, start });
    }
  }
  return links.toSorted((a, b) => a.start - b.start);
}
