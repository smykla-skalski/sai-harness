export type CoordinationMessage = {
  id: string;
  target: string;
  sender: string;
  text: string;
  created: number;
  delivered?: boolean;
};

export function coordinationKey(directory: string, threadId: string): string {
  return `${directory}\0${threadId}`;
}

export function loadCoordinationMessages(raw: string | null): CoordinationMessage[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is CoordinationMessage =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.target === 'string' &&
        typeof item.sender === 'string' &&
        typeof item.text === 'string' &&
        typeof item.created === 'number' &&
        (item.delivered === undefined || typeof item.delivered === 'boolean'),
    );
  } catch {
    return [];
  }
}
