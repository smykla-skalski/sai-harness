export function toolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') {
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch {
      return input;
    }
  }
  return JSON.stringify(input, null, 2) ?? '';
}

export function toolCommand(input: unknown): string | null {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || !('command' in value)) return null;
  return typeof value.command === 'string' && value.command.trim() ? value.command : null;
}
