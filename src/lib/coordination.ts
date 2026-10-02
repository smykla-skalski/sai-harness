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

export function coordinationPrompt(message: CoordinationMessage): string {
  return `Message ${message.id} from ${message.sender}:\n\n${message.text}`;
}

export function coordinationMessageForText(
  text: string,
  messages: CoordinationMessage[],
): CoordinationMessage | undefined {
  return messages.find((message) => text.includes(coordinationPrompt(message)));
}

export function enqueueCoordinationMessage(
  existing: CoordinationMessage[],
  message: CoordinationMessage,
  limit = 500,
): CoordinationMessage[] {
  const retained = [...existing];
  while (retained.length >= limit) {
    const delivered = retained.findIndex((item) => item.delivered);
    if (delivered < 0) throw new Error('Agent message queue is full.');
    retained.splice(delivered, 1);
  }
  return [...retained, message];
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
