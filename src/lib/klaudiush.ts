export interface KlaudiushRule {
  code: string;
  reason: string;
}

export function klaudiushRules(text: string): KlaudiushRule[] {
  if (!/PreToolUse:\w+ says:/.test(text)) return [];
  const lines = text.replaceAll(/PreToolUse:\w+ says:\s*/g, '\n').split('\n');
  const rules = new Map<string, KlaudiushRule>();
  for (const line of lines) {
    const match = line.match(/❌\s*([A-Z]+\d{3}):\s*(.+)/);
    if (match && !rules.has(match[1])) {
      rules.set(match[1], { code: match[1], reason: match[2].trim() });
    }
  }
  return [...rules.values()];
}

export function blockedHookRules(tools: { status: string; content: string }[]): KlaudiushRule[] {
  return klaudiushRules(
    tools
      .filter((tool) => /fail|error|reject/i.test(tool.status))
      .map((tool) => tool.content)
      .join('\n'),
  );
}

export function splitKlaudiushMessage(text: string): {
  rules: KlaudiushRule[];
  notice: string;
  remainder: string;
} | null {
  if (!text.startsWith('**Notice:**')) return null;
  const paragraphs = text.split(/\n\s*\n/);
  let noticeEnd = 1;
  while (noticeEnd < paragraphs.length && /^\s*PreToolUse:\w+ says:/.test(paragraphs[noticeEnd]))
    noticeEnd++;
  const notice = paragraphs.slice(0, noticeEnd).join('\n\n');
  const rules = klaudiushRules(notice);
  if (!rules.length) return null;
  return { rules, notice, remainder: paragraphs.slice(noticeEnd).join('\n\n').trim() };
}
