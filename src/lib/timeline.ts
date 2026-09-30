import type { SessionMessageInfo } from '@opencode/client';

export function mergeMessages(
  existing: SessionMessageInfo[],
  incoming: SessionMessageInfo[],
): SessionMessageInfo[] {
  const byID = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byID.set(message.id, message);
  return [...byID.values()].toSorted(
    (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
  );
}

export function nearBottom(
  element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}
