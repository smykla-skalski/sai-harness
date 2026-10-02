<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { terminalTheme } from './lib/terminal-theme';

  type Snapshot = {
    output: string;
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
  let exitStatus = $state<Snapshot['exitStatus']>(null);
  let released = $state(false);
  let lastOutput = '';
  let disposed = false;

  async function refresh() {
    try {
      const snapshot = await invoke<Snapshot>('acp_terminal_snapshot', { id });
      if (disposed) return;
      if (!snapshot.output.startsWith(lastOutput)) {
        terminal.reset();
        if (snapshot.truncated) terminal.write('[Earlier output truncated]\r\n');
        terminal.write(snapshot.output);
      } else if (snapshot.output.length > lastOutput.length) {
        terminal.write(snapshot.output.slice(lastOutput.length));
      }
      lastOutput = snapshot.output;
      exitStatus = snapshot.exitStatus;
      released = snapshot.released;
      error = '';
    } catch (cause) {
      if (!disposed) error = String(cause);
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
    const poll = window.setInterval(() => void refresh(), 250);
    return () => {
      disposed = true;
      clearInterval(poll);
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
      >{:else}<span role="status">Command running</span>{/if}
    <button disabled={!!exitStatus || released} onclick={stop}>Stop command</button>
  </div>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
</div>
