const pending = new Map<string, Promise<unknown>>();

export function runSerialOpenCodeTurn<T>(sessionId: string, turn: () => Promise<T>): Promise<T> {
  const previous = pending.get(sessionId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(turn);
  const settled = result.catch(() => undefined);
  pending.set(sessionId, settled);
  void settled.then(() => {
    if (pending.get(sessionId) === settled) pending.delete(sessionId);
    return undefined;
  });
  return result;
}
