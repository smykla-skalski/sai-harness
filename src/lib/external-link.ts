import { invoke, isTauri } from '@tauri-apps/api/core';

export function openExternalLink(event: MouseEvent, url: string): void {
  if (!isTauri() || url.startsWith('#')) return;
  event.preventDefault();
  void invoke('open_external_url', { url }).catch((error: unknown) => {
    console.error('Could not open external link:', error);
  });
}
