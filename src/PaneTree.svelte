<script lang="ts">
  import type { Snippet } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import type { FileDiffInfo } from '@opencode/client';
  import PaneTree from './PaneTree.svelte';
  import AgentWorkspace from './AgentWorkspace.svelte';
  import DiffPanel from './DiffPanel.svelte';
  import type { AgentThread, AgentAvailability } from './lib/acp';
  import type { Pane } from './lib/panes';

  type Props = {
    pane: Pane;
    focused: string;
    directory: string;
    agents: AgentAvailability[];
    changesPanes: string[];
    main: Snippet;
    canClose: boolean;
    onfocus: (id: string) => void;
    onclose: (id: string) => void;
    onratio: (id: string, ratio: number) => void;
    oncreated: (id: string, thread: AgentThread) => void;
    onactivity: (thread: AgentThread) => void;
    focusPromptPane: string | null;
    onpromptfocused: () => void;
    running: (thread: AgentThread | null) => boolean;
    onstatus: (thread: AgentThread, running: boolean) => void;
    onchanges: (id: string) => void;
  };

  let {
    pane,
    focused,
    directory,
    agents,
    changesPanes,
    main,
    canClose,
    onfocus,
    onclose,
    onratio,
    oncreated,
    onactivity,
    focusPromptPane,
    onpromptfocused,
    running,
    onstatus,
    onchanges,
  }: Props = $props();
  let container = $state<HTMLDivElement>();
  let dragging = false;
  let previewRatio = $state<number | null>(null);
  let diffs = $state<FileDiffInfo[]>([]);
  let diffLoading = $state(false);
  let diffError = $state('');
  let selectedFile = $state<string | null>(null);
  let diffGeneration = 0;

  async function refreshDiff() {
    const current = ++diffGeneration;
    diffLoading = true;
    try {
      const files = await invoke<FileDiffInfo[]>('working_tree_diff', { path: directory });
      if (current !== diffGeneration) return;
      diffs = files;
      selectedFile =
        files.find((file) => file.file === selectedFile)?.file ?? files[0]?.file ?? null;
      diffError = '';
    } catch (cause) {
      if (current === diffGeneration) diffError = String(cause);
    } finally {
      if (current === diffGeneration) diffLoading = false;
    }
  }

  $effect(() => {
    if (!('direction' in pane) && pane.id !== 'main' && changesPanes.includes(pane.id))
      void refreshDiff();
  });

  function ratioFromPointer(event: PointerEvent) {
    const bounds = container!.getBoundingClientRect();
    const span =
      pane && 'direction' in pane && pane.direction === 'row' ? bounds.width : bounds.height;
    const offset =
      pane && 'direction' in pane && pane.direction === 'row'
        ? event.clientX - bounds.left
        : event.clientY - bounds.top;
    return Math.max(0.1, Math.min(0.9, offset / span));
  }

  function resizeKey(event: KeyboardEvent) {
    if (!('direction' in pane)) return;
    const step = event.shiftKey ? 0.1 : 0.02;
    const change =
      pane.direction === 'row'
        ? event.key === 'ArrowRight'
          ? step
          : event.key === 'ArrowLeft'
            ? -step
            : 0
        : event.key === 'ArrowDown'
          ? step
          : event.key === 'ArrowUp'
            ? -step
            : 0;
    if (!change) return;
    event.preventDefault();
    onratio(pane.id, Math.max(0.1, Math.min(0.9, pane.ratio + change)));
  }
</script>

{#if 'direction' in pane}
  <div
    class="pane-split"
    class:row={pane.direction === 'row'}
    class:column={pane.direction === 'column'}
    style={`--pane-ratio: ${(previewRatio ?? pane.ratio) * 100}%`}
    bind:this={container}
  >
    <PaneTree
      pane={pane.first}
      {focused}
      {directory}
      {agents}
      {changesPanes}
      {main}
      {canClose}
      {onfocus}
      {onclose}
      {onratio}
      {oncreated}
      {onactivity}
      {focusPromptPane}
      {onpromptfocused}
      {running}
      {onstatus}
      {onchanges}
    />
    <div
      class="pane-divider"
      role="slider"
      tabindex="0"
      aria-label="Split pane divider"
      aria-orientation={pane.direction === 'row' ? 'vertical' : 'horizontal'}
      aria-valuemin="10"
      aria-valuemax="90"
      aria-valuenow={Math.round(pane.ratio * 100)}
      onpointerdown={(event) => {
        if (event.button !== 0) return;
        dragging = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onpointermove={(event) => {
        if (dragging) previewRatio = ratioFromPointer(event);
      }}
      onpointerup={() => {
        dragging = false;
        if (previewRatio !== null) onratio(pane.id, previewRatio);
        previewRatio = null;
      }}
      onpointercancel={() => {
        dragging = false;
        previewRatio = null;
      }}
      onkeydown={resizeKey}
    ></div>
    <PaneTree
      pane={pane.second}
      {focused}
      {directory}
      {agents}
      {changesPanes}
      {main}
      {canClose}
      {onfocus}
      {onclose}
      {onratio}
      {oncreated}
      {onactivity}
      {focusPromptPane}
      {onpromptfocused}
      {running}
      {onstatus}
      {onchanges}
    />
  </div>
{:else}
  <section
    class="pane-leaf"
    class:focused={focused === pane.id}
    data-pane-id={pane.id}
    aria-keyshortcuts="Meta+Alt+ArrowLeft Meta+Alt+ArrowRight Meta+Alt+ArrowUp Meta+Alt+ArrowDown F6 Shift+F6"
    aria-label={pane.agent ? `${pane.agent} pane` : 'Main pane'}
    tabindex="-1"
    onfocusin={() => onfocus(pane.id)}
    onpointerdown={() => onfocus(pane.id)}
  >
    {#if pane.id !== 'main'}
      <div class="pane-heading">
        <span>{pane.thread?.title ?? `New ${pane.agent} thread`}</span><small
          >⌘⌥ + arrow to switch</small
        ><button aria-label="Close pane" onclick={() => onclose(pane.id)}>×</button>
      </div>
    {:else if canClose}
      <div class="pane-heading">
        <span>Main thread</span><small>⌘⌥ + arrow to switch</small><button
          aria-label="Close main pane"
          onclick={() => onclose(pane.id)}>×</button
        >
      </div>
    {/if}
    {#if pane.id === 'main'}
      {@render main()}
    {:else if pane.agent}
      {#key `${pane.id}:${pane.agent}`}
        <div class="pane-agent-content" class:changes-open={changesPanes.includes(pane.id)}>
          <AgentWorkspace
            agent={pane.agent}
            agentName={agents.find((agent) => agent.id === pane.agent)?.name ?? pane.agent}
            {directory}
            thread={pane.thread}
            running={running(pane.thread)}
            focused={focused === pane.id}
            focusPrompt={focusPromptPane === pane.id}
            {onpromptfocused}
            oncreated={(thread) => oncreated(pane.id, thread)}
            {onactivity}
            {onstatus}
          />
          {#if changesPanes.includes(pane.id)}
            <DiffPanel
              files={diffs}
              annotations={{}}
              selected={selectedFile}
              loading={diffLoading}
              error={diffError}
              onselect={(file) => (selectedFile = file)}
              onrefresh={refreshDiff}
              onclose={() => onchanges(pane.id)}
            />
          {/if}
        </div>
      {/key}
    {/if}
  </section>
{/if}
