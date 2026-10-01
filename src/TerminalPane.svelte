<script lang="ts">
  import { onMount } from 'svelte';
  import { Channel, invoke } from '@tauri-apps/api/core';
  import { Terminal, type ILink } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { terminalFileLinks } from './lib/terminal-links';

  type TerminalEvent = { kind: 'output'; data: number[] } | { kind: 'exit'; code: number };

  let {
    id,
    directory,
    focused,
    onshortcut,
  }: {
    id: string;
    directory: string;
    focused: boolean;
    onshortcut: (event: KeyboardEvent) => void;
  } = $props();
  let container: HTMLDivElement;
  let terminal: Terminal;
  let fit: FitAddon;
  let observer: ResizeObserver;
  let exitCode = $state<number | null>(null);
  let error = $state('');
  let disposed = false;
  let started = false;
  let generation = 0;
  const attachment = crypto.randomUUID();

  function channel(): Channel<TerminalEvent> {
    const current = ++generation;
    const receiver = new Channel<TerminalEvent>();
    Object.assign(receiver, {
      onmessage: (event: TerminalEvent) => {
        if (disposed || current !== generation) return;
        if (event.kind === 'output') terminal.write(new Uint8Array(event.data));
        else exitCode = event.code;
      },
    });
    return receiver;
  }

  async function open() {
    try {
      await invoke('terminal_open', {
        id,
        directory,
        cols: terminal.cols,
        rows: terminal.rows,
        attachment,
        onEvent: channel(),
      });
      started = true;
      error = '';
      if (focused) terminal.focus();
    } catch (cause) {
      error = String(cause);
    }
  }

  async function restart() {
    try {
      ++generation;
      await invoke('terminal_close', { id });
      terminal.reset();
      exitCode = null;
      started = false;
      await open();
    } catch (cause) {
      error = String(cause);
    }
  }

  function resize() {
    if (!container.clientWidth || !container.clientHeight) return;
    fit.fit();
    if (started)
      void invoke('terminal_resize', { id, cols: terminal.cols, rows: terminal.rows }).catch(
        (cause) => (error = String(cause)),
      );
  }

  onMount(() => {
    terminal = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      screenReaderMode: true,
    });
    fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const key = event.key.toLowerCase();
      const appShortcut =
        (event.metaKey || event.ctrlKey) &&
        ((!event.altKey && ['w', 'd', 't', 'k'].includes(key)) ||
          (event.altKey && key.startsWith('arrow')));
      if (!appShortcut && event.key !== 'F6') return true;
      onshortcut(event);
      event.stopPropagation();
      return false;
    });
    terminal.onData((data) => {
      void invoke('terminal_write', { id, data: [...new TextEncoder().encode(data)] }).catch(
        (cause) => (error = String(cause)),
      );
    });
    terminal.onBinary((data) => {
      void invoke('terminal_write', {
        id,
        data: [...data].map((character) => character.codePointAt(0) ?? 0),
      }).catch((cause) => (error = String(cause)));
    });
    terminal.registerLinkProvider({
      provideLinks(line, callback) {
        const content = terminal.buffer.active.getLine(line - 1)?.translateToString() ?? '';
        const links: ILink[] = [];
        for (const link of terminalFileLinks(content)) {
          links.push({
            text: link.text,
            range: {
              start: { x: link.start, y: line },
              end: { x: link.start + link.text.length, y: line },
            },
            activate: () =>
              void invoke('terminal_open_file', {
                id,
                path: link.path,
                line: link.line,
              }).catch((cause) => (error = String(cause))),
          });
        }
        callback(links);
      },
    });
    observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    void open();
    return () => {
      disposed = true;
      ++generation;
      observer.disconnect();
      terminal.dispose();
      void invoke('terminal_detach', { id, attachment });
    };
  });

  $effect(() => {
    if (focused && terminal) terminal.focus();
  });
</script>

<div class="terminal-pane" aria-label="Shell terminal">
  <div class="terminal-screen" bind:this={container}></div>
  {#if exitCode !== null}<div class="terminal-exit" role="status">
      Shell exited with code {exitCode}. <button onclick={restart}>Restart</button>
    </div>{/if}
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
</div>
