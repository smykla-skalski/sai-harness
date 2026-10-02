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

export function splitKlaudiushMessage(text: string): {
  rules: KlaudiushRule[];
  notice: string;
  remainder: string;
} | null {
  if (!text.startsWith('**Notice:**')) return null;
  const firstBreak = text.search(/\n\s*\n/);
  const notice = firstBreak < 0 ? text : text.slice(0, firstBreak);
  const rules = klaudiushRules(notice);
  if (!rules.length) return null;
  return { rules, notice, remainder: firstBreak < 0 ? '' : text.slice(firstBreak).trim() };
}
