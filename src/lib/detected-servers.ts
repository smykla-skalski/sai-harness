import { invoke } from '@tauri-apps/api/core';

export type DetectedServer = { port: number; url: string };

type Watch = {
  listeners: Set<(servers: DetectedServer[]) => void>;
  servers: DetectedServer[];
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
};

const watches = new Map<string, Watch>();

export function watchDetectedServers(
  directory: string,
  listener: (servers: DetectedServer[]) => void,
): () => void {
  let watch = watches.get(directory);
  if (!watch) {
    watch = {
      listeners: new Set(),
      servers: [],
      timer: null,
      running: false,
    };
    const current = watch;
    const refresh = async () => {
      if (current.running) return;
      current.running = true;
      try {
        current.servers = await invoke<DetectedServer[]>('browser_detected_servers', { directory });
      } catch {
        current.servers = [];
      } finally {
        current.running = false;
      }
      for (const subscriber of current.listeners) subscriber(current.servers);
    };
    watches.set(directory, watch);
    watch.timer = setInterval(() => void refresh(), 5000);
    void refresh();
  }
  watch.listeners.add(listener);
  listener(watch.servers);
  return () => {
    watch.listeners.delete(listener);
    if (watch.listeners.size) return;
    if (watch.timer) clearInterval(watch.timer);
    watches.delete(directory);
  };
}
