<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { terminalTheme } from './lib/terminal-theme';

  type Delta = {
    outputBase64: string;
    cursor: number;
    reset: boolean;
    truncated: boolean;
    exitStatus: { exitCode: number | null; signal: string | null } | null;
    released: boolean;
  };

  let { id, dark }: { id: string; dark: boolean } = $props();
  let container: HTMLDivElement;
  let terminal: Terminal;
  let fit: FitAddon;
  let observer: ResizeObserver;
  let error = $state('');
  let exitStatus = $state<Delta['exitStatus']>(null);
  let released = $state(false);
  let unavailable = $state(false);
  let cursor = 0;
  let poll: ReturnType<typeof setTimeout>;
  let refreshing = false;
  let disposed = false;

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const delta = await invoke<Delta>('acp_terminal_delta', { id, cursor });
      if (disposed) return;
      if (delta.reset) {
        terminal.reset();
      }
      if ((delta.reset || cursor === 0) && delta.truncated)
        terminal.write('[Earlier output truncated]\r\n');
      if (delta.outputBase64) {
        const bytes = atob(delta.outputBase64);
        terminal.write(Uint8Array.from(bytes, (byte) => byte.charCodeAt(0)));
      }
      cursor = delta.cursor;
      exitStatus = delta.exitStatus;
      released = delta.released;
      error = '';
    } catch (cause) {
      if (!disposed) {
        error = String(cause);
        unavailable = error.includes('Terminal is no longer available');
      }
    } finally {
      refreshing = false;
      if (!disposed && !exitStatus && !released && !unavailable)
        poll = setTimeout(() => void refresh(), 250);
    }
  }

  async function stop() {
    try {
      await invoke('acp_terminal_stop', { id });
      await refresh();
    } catch (cause) {
      error = String(cause);
    }
  }

  onMount(() => {
    terminal = new Terminal({
      scrollback: 5000,
      screenReaderMode: true,
      theme: terminalTheme(dark),
    });
    fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    observer = new ResizeObserver(() => fit.fit());
    observer.observe(container);
    fit.fit();
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(poll);
      observer.disconnect();
      terminal.dispose();
    };
  });

  $effect(() => {
    if (terminal) terminal.options.theme = terminalTheme(dark);
  });
</script>

<div class="terminal-pane" aria-label="Agent command terminal">
  <div class="terminal-screen" bind:this={container}></div>
  <div class="agent-terminal-status">
    {#if exitStatus}<span role="status"
        >Command exited with
        {exitStatus.exitCode === null
          ? (exitStatus.signal ?? 'a signal')
          : `code ${exitStatus.exitCode}`}.</span
      >{:else if released}<span role="status">Command closed.</span>{:else}<span role="status"
        >Command running</span
      >{/if}
    <button disabled={!!exitStatus || released || unavailable} onclick={stop}>Stop command</button>
  </div>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
</div>
