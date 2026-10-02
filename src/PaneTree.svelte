<script lang="ts">
  import type { Snippet } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import type { WorkingDiffInfo } from './lib/diff';
  import PaneTree from './PaneTree.svelte';
  import AgentWorkspace from './AgentWorkspace.svelte';
  import DiffPanel from './DiffPanel.svelte';
  import EmptyPanePicker from './EmptyPanePicker.svelte';
  import TerminalPane from './TerminalPane.svelte';
  import AgentTerminalPane from './AgentTerminalPane.svelte';
  import BrowserPane from './BrowserPane.svelte';
  import type { AgentThread, AgentAvailability } from './lib/acp';
  import type { BrowserAttachment } from './lib/browser-pick';
  import type { DiffComment } from './lib/diff-comments';
  import type { ThreadStatus } from './lib/attention';
  import { clampPaneRatio, paneRatioBounds, type BrowserTab, type Pane } from './lib/panes';

  type Props = {
    pane: Pane;
    focused: string;
    directory: string;
    dark: boolean;
    agents: AgentAvailability[];
    changesPanes: string[];
    main: Snippet;
    canClose: boolean;
    onfocus: (id: string) => void;
    onclose: (id: string) => void;
    onratio: (id: string, ratio: number) => void;
    oncreated: (id: string, thread: AgentThread) => void;
    onchooseagent: (id: string, agent: string) => void;
    onchooseterminal: (id: string) => void;
    onchoosebrowser: (id: string) => void;
    onbrowserstate: (id: string, tabs: BrowserTab[], activeTab: string) => void;
    onbrowserpick: (id: string, attachment: BrowserAttachment) => void;
    pickedAttachments: Record<string, BrowserAttachment>;
    onpickedconsumed: (id: string) => void;
    diffComments: Record<string, DiffComment[]>;
    ondiffcomments: (scope: string, comments: DiffComment[]) => void;
    ondiffcommentssent: (scope: string, ids: string[]) => void;
    onsenddiffcomments: (id: string, scope: string, text: string) => Promise<void>;
    pendingAgentBatches: Record<string, { id: string; text: string }>;
    onbatchcomplete: (id: string, failure: string | null) => void;
    onshortcut: (event: KeyboardEvent) => void;
    onactivity: (thread: AgentThread) => void;
    focusPromptPane: string | null;
    onpromptfocused: () => void;
    running: (thread: AgentThread | null) => boolean;
    onstatus: (thread: AgentThread, status: ThreadStatus, notifyOnDone?: boolean) => void;
    onchanges: (id: string) => void;
    pendingCommands: Record<string, string>;
    oncommandstarted: (id: string) => void;
    onterminalexit: (id: string, code: number) => void;
    onagentterminal: (id: string) => void;
  };

  let {
    pane,
    focused,
    directory,
    dark,
    agents,
    changesPanes,
    main,
    canClose,
    onfocus,
    onclose,
    onratio,
    oncreated,
    onchooseagent,
    onchooseterminal,
    onchoosebrowser,
    onbrowserstate,
    onbrowserpick,
    pickedAttachments,
    onpickedconsumed,
    diffComments,
    ondiffcomments,
    ondiffcommentssent,
    onsenddiffcomments,
    pendingAgentBatches,
    onbatchcomplete,
    onshortcut,
    onactivity,
    focusPromptPane,
    onpromptfocused,
    running,
    onstatus,
    onchanges,
    pendingCommands,
    oncommandstarted,
    onterminalexit,
    onagentterminal,
  }: Props = $props();
  let container = $state<HTMLDivElement>();
  let splitWidth = $state(0);
  let splitHeight = $state(0);
  let dragging = false;
  let previewRatio = $state<number | null>(null);
  const splitSpan = $derived(
    'direction' in pane ? (pane.direction === 'row' ? splitWidth : splitHeight) : 0,
  );
  const ratioBounds = $derived(paneRatioBounds(splitSpan));
  const visibleRatio = $derived(
    clampPaneRatio(previewRatio ?? ('direction' in pane ? pane.ratio : 0.5), splitSpan),
  );
  let diffs = $state<WorkingDiffInfo[]>([]);
  let diffLoading = $state(false);
  let diffError = $state('');
  let selectedFile = $state<string | null>(null);
  let diffGeneration = 0;

  async function refreshDiff() {
    const current = ++diffGeneration;
    diffLoading = true;
    try {
      const files = await invoke<WorkingDiffInfo[]>('working_tree_diff', { path: directory });
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
    if ('direction' in pane || pane.id === 'main' || !changesPanes.includes(pane.id)) return;
    void refreshDiff();
    const timer = setInterval(() => void refreshDiff(), 5000);
    return () => clearInterval(timer);
  });

  function ratioFromPointer(event: PointerEvent) {
    const bounds = container!.getBoundingClientRect();
    const span =
      pane && 'direction' in pane && pane.direction === 'row' ? bounds.width : bounds.height;
    const offset =
      pane && 'direction' in pane && pane.direction === 'row'
        ? event.clientX - bounds.left
        : event.clientY - bounds.top;
    return clampPaneRatio(offset / span, span);
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
    onratio(pane.id, clampPaneRatio(visibleRatio + change, splitSpan));
  }
</script>

{#if 'direction' in pane}
  <div
    class="pane-split"
    class:row={pane.direction === 'row'}
    class:column={pane.direction === 'column'}
    style={`--pane-ratio: ${visibleRatio * 100}%`}
    bind:this={container}
    bind:clientWidth={splitWidth}
    bind:clientHeight={splitHeight}
  >
    <PaneTree
      pane={pane.first}
      {focused}
      {directory}
      {dark}
      {agents}
      {changesPanes}
      {main}
      {canClose}
      {onfocus}
      {onclose}
      {onratio}
      {oncreated}
      {onchooseagent}
      {onchooseterminal}
      {onchoosebrowser}
      {onbrowserstate}
      {onbrowserpick}
      {pickedAttachments}
      {onpickedconsumed}
      {diffComments}
      {ondiffcomments}
      {ondiffcommentssent}
      {onsenddiffcomments}
      {pendingAgentBatches}
      {onbatchcomplete}
      {onshortcut}
      {onactivity}
      {focusPromptPane}
      {onpromptfocused}
      {running}
      {onstatus}
      {onchanges}
      {pendingCommands}
      {oncommandstarted}
      {onterminalexit}
      {onagentterminal}
    />
    <div
      class="pane-divider"
      role="slider"
      tabindex="0"
      aria-label="Split pane divider"
      aria-orientation={pane.direction === 'row' ? 'vertical' : 'horizontal'}
      aria-valuemin={Math.round(ratioBounds.min * 100)}
      aria-valuemax={Math.round(ratioBounds.max * 100)}
      aria-valuenow={Math.round(visibleRatio * 100)}
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
      {dark}
      {agents}
      {changesPanes}
      {main}
      {canClose}
      {onfocus}
      {onclose}
      {onratio}
      {oncreated}
      {onchooseagent}
      {onchooseterminal}
      {onchoosebrowser}
      {onbrowserstate}
      {onbrowserpick}
      {pickedAttachments}
      {onpickedconsumed}
      {diffComments}
      {ondiffcomments}
      {ondiffcommentssent}
      {onsenddiffcomments}
      {pendingAgentBatches}
      {onbatchcomplete}
      {onshortcut}
      {onactivity}
      {focusPromptPane}
      {onpromptfocused}
      {running}
      {onstatus}
      {onchanges}
      {pendingCommands}
      {oncommandstarted}
      {onterminalexit}
      {onagentterminal}
    />
  </div>
{:else}
  <section
    class="pane-leaf"
    class:focused={focused === pane.id}
    data-pane-id={pane.id}
    aria-keyshortcuts="Meta+Alt+ArrowLeft Meta+Alt+ArrowRight Meta+Alt+ArrowUp Meta+Alt+ArrowDown F6 Shift+F6"
    aria-label={pane.id === 'main'
      ? 'Main pane'
      : pane.kind === 'terminal'
        ? 'Terminal pane'
        : pane.kind === 'agent-terminal'
          ? 'Agent terminal pane'
          : pane.kind === 'browser'
            ? 'Browser pane'
            : pane.agent
              ? `${pane.agent} pane`
              : 'Empty pane'}
    tabindex="-1"
    onfocusin={() => onfocus(pane.id)}
    onpointerdown={(event) => {
      onfocus(pane.id);
      if (
        pane.id === 'main' ||
        pane.agent ||
        pane.kind === 'terminal' ||
        pane.kind === 'agent-terminal' ||
        pane.kind === 'browser' ||
        !(event.target instanceof Element)
      )
        return;
      if (event.target.closest('button, input, textarea, select')) return;
      (
        event.currentTarget.querySelector<HTMLButtonElement>(
          '[data-agent-choice]:not(:disabled), [data-pane-picker]',
        ) ?? event.currentTarget
      ).focus();
    }}
  >
    {#if pane.id !== 'main'}
      <div class="pane-heading">
        <span
          >{pane.kind === 'terminal'
            ? 'Terminal'
            : pane.kind === 'agent-terminal'
              ? 'Agent terminal'
              : pane.kind === 'browser'
                ? 'Browser'
                : (pane.thread?.title ??
                  (pane.agent ? `New ${pane.agent} thread` : 'Empty pane'))}</span
        ><small>⌘⌥ + arrow to switch</small><button
          aria-label="Close pane"
          onclick={() => onclose(pane.id)}>×</button
        >
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
    {:else if pane.kind === 'terminal'}
      {#key `${directory}:${pane.id}`}
        <TerminalPane
          id={pane.id}
          {directory}
          {dark}
          focused={focused === pane.id}
          {onshortcut}
          command={pendingCommands[pane.id]}
          {oncommandstarted}
          onexit={onterminalexit}
        />
      {/key}
    {:else if pane.kind === 'agent-terminal'}
      <AgentTerminalPane id={pane.terminalId} {dark} />
    {:else if pane.kind === 'browser'}
      {#key `${directory}:${pane.id}`}
        <BrowserPane
          {pane}
          {directory}
          onstate={(tabs, activeTab) => onbrowserstate(pane.id, tabs, activeTab)}
          onpick={(attachment) => onbrowserpick(pane.id, attachment)}
          onfocus={() => onfocus(pane.id)}
          {onshortcut}
        />
      {/key}
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
            picked={pickedAttachments[pane.id]}
            externalPrompt={pendingAgentBatches[pane.id]}
            onexternalresult={onbatchcomplete}
            {onpickedconsumed}
            {onpromptfocused}
            oncreated={(thread) => oncreated(pane.id, thread)}
            {onactivity}
            {onstatus}
            onterminal={onagentterminal}
          />
          {#if changesPanes.includes(pane.id)}
            <DiffPanel
              {directory}
              files={diffs}
              annotations={{}}
              selected={selectedFile}
              loading={diffLoading}
              error={diffError}
              onselect={(file) => (selectedFile = file)}
              onrefresh={refreshDiff}
              onclose={() => onchanges(pane.id)}
              scope={`${directory}\0${pane.id}\0acp:${pane.agent}:${pane.thread?.sessionId ?? 'new'}`}
              comments={diffComments[
                `${directory}\0${pane.id}\0acp:${pane.agent}:${pane.thread?.sessionId ?? 'new'}`
              ] ?? []}
              oncomments={ondiffcomments}
              oncommentssent={ondiffcommentssent}
              onsendcomments={(scope, text) => onsenddiffcomments(pane.id, scope, text)}
            />
          {/if}
        </div>
      {/key}
    {:else}
      <EmptyPanePicker
        {agents}
        focused={focused === pane.id}
        onselect={(agent) => onchooseagent(pane.id, agent)}
        onterminal={() => onchooseterminal(pane.id)}
        onbrowser={() => onchoosebrowser(pane.id)}
      />
    {/if}
  </section>
{/if}
