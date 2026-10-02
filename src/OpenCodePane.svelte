<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { invoke } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-dialog';
  import { Badge, Button } from '@smykla-skalski/sui';
  import type { FormInfo, PermissionRequest } from '@opencode/client';
  import Markdown from './Markdown.svelte';
  import OptionPicker from './OptionPicker.svelte';
  import PromptPanel from './PromptPanel.svelte';
  import type { AgentThread } from './lib/acp';
  import type { BrowserAttachment } from './lib/browser-pick';
  import {
    coordinationMessageForText,
    coordinationPrompt,
    type CoordinationMessage,
  } from './lib/coordination';
  import type { ThreadStatus } from './lib/attention';
  import { fileUri } from './lib/attachments';
  import type { SetupReport } from './lib/onboarding';
  import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from './lib/opencode';
  import { mergeMessages, nearBottom } from './lib/timeline';

  let {
    client,
    directory,
    thread,
    setup,
    coordinationMessages = [],
    focused,
    focusPrompt,
    picked,
    externalPrompt,
    onexternalresult,
    onpickedconsumed,
    onpromptfocused,
    oncreated,
    onactivity,
    onstatus,
  }: {
    client: OpenCodeClient | null;
    directory: string;
    thread: AgentThread | null;
    setup: SetupReport | null;
    coordinationMessages?: CoordinationMessage[];
    focused: boolean;
    focusPrompt: boolean;
    picked?: BrowserAttachment;
    externalPrompt?: { id: string; text: string };
    onexternalresult?: (id: string, failure: string | null) => void;
    onpickedconsumed?: (id: string) => void;
    onpromptfocused?: () => void;
    oncreated: (thread: AgentThread) => void;
    onactivity: (thread: AgentThread) => void;
    onstatus: (thread: AgentThread, status: ThreadStatus, notifyOnDone?: boolean) => void;
  } = $props();

  let session = $state<SessionInfo | null>(null);
  let messages = $state<SessionMessageInfo[]>([]);
  let cursor = $state<string | null>(null);
  let pendingPermissions = $state<PermissionRequest[]>([]);
  let pendingForms = $state<FormInfo[]>([]);
  let draft = $state('');
  let files = $state<string[]>([]);
  let error = $state('');
  let loading = $state(false);
  let loadingOlder = $state(false);
  let sending = $state(false);
  let running = $state(false);
  let pickerOpen = $state<'agent' | 'model' | 'effort' | null>(null);
  let selectedAgent = $state('');
  let selectedModel = $state('');
  let selectedVariant = $state('');
  let scroll: HTMLDivElement;
  let prompt: HTMLTextAreaElement;
  let activeID = $state<string | null>(null);
  let selectedThreadId: string | null | undefined;
  let selectedClient: OpenCodeClient | null = null;
  const pickedImages = new SvelteSet<string>();
  let generation = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let mounted = $state(false);
  let lastPicked = '';
  let lastExternalPrompt = '';
  let following = true;
  let stopRequested = false;
  const busy = $derived(sending || running);
  const inputReady = $derived(
    !!setup?.workReady || (session?.agent === 'architect' && !!setup?.planReady),
  );
  const chosenModel = $derived(
    setup?.models.find((model) => `${model.providerID}:${model.id}` === selectedModel),
  );
  const agentChoices = $derived(
    (setup?.agents ?? []).map((agent) => ({ value: agent.id, name: agent.name })),
  );
  const modelChoices = $derived(
    (setup?.models ?? []).map((model) => ({
      value: `${model.providerID}:${model.id}`,
      name: `${model.providerID} / ${model.name}`,
    })),
  );
  const effortChoices = $derived(
    (chosenModel?.variants ?? []).map((variant) => ({ value: variant.id, name: variant.id })),
  );

  function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  function summary(info: SessionInfo): AgentThread {
    return {
      agent: 'opencode',
      sessionId: info.id,
      directory,
      title: info.title ?? 'OpenCode thread',
      updated: info.time.updated,
    };
  }

  async function follow() {
    await tick();
    if (scroll && following) scroll.scrollTop = scroll.scrollHeight;
  }

  async function refreshMessages(id: string, current = generation) {
    if (!client) return;
    const page = await client.message.list({ sessionID: id, limit: 50, order: 'desc' });
    if (current !== generation || id !== activeID) return;
    const first = !messages.length;
    messages = first ? page.data.toReversed() : mergeMessages(messages, page.data);
    if (first) cursor = page.cursor.next ?? null;
    await follow();
    if (scroll?.scrollHeight <= scroll?.clientHeight && cursor) void loadOlder();
  }

  async function loadOlder() {
    if (!client || !activeID || !cursor || loadingOlder) return;
    const id = activeID;
    const current = generation;
    const next = cursor;
    const height = scroll.scrollHeight;
    const top = scroll.scrollTop;
    const underfilled = height <= scroll.clientHeight;
    let loaded = false;
    loadingOlder = true;
    try {
      const page = await client.message.list({ sessionID: id, limit: 50, cursor: next });
      if (current !== generation || id !== activeID) return;
      messages = mergeMessages(messages, page.data);
      cursor = page.cursor.next === next ? null : (page.cursor.next ?? null);
      if (!underfilled) following = false;
      await tick();
      scroll.scrollTop =
        underfilled && following ? scroll.scrollHeight : top + scroll.scrollHeight - height;
      loaded = true;
    } catch (cause) {
      if (current === generation) error = describe(cause);
    } finally {
      loadingOlder = false;
      if (loaded && scroll.scrollHeight <= scroll.clientHeight && cursor) void loadOlder();
    }
  }

  async function refreshRequests(id: string, current = generation) {
    if (!client) return;
    const [permissions, forms] = await Promise.all([
      client.permission.list({ sessionID: id }),
      client.session.form.list({ sessionID: id }),
    ]);
    if (current !== generation || id !== activeID) return;
    pendingPermissions = permissions;
    pendingForms = forms;
  }

  async function activate(id: string | null) {
    const current = ++generation;
    clearTimeout(refreshTimer);
    if (!sending) {
      for (const path of pickedImages) void invoke('browser_remove_capture', { path });
      pickedImages.clear();
    }
    draft = '';
    files = [];
    selectedThreadId = id;
    activeID = id;
    session = null;
    messages = [];
    cursor = null;
    pendingPermissions = [];
    pendingForms = [];
    error = '';
    sending = false;
    running = false;
    following = true;
    selectedAgent = setup?.agents.find((agent) => agent.id !== 'architect')?.id ?? '';
    selectedModel = setup?.defaultModel
      ? `${setup.defaultModel.providerID}:${setup.defaultModel.id}`
      : '';
    selectedVariant = setup?.defaultModel?.variant ?? '';
    if (!client || !id) return;
    loading = true;
    try {
      const [info, active] = await Promise.all([
        client.session.get({ sessionID: id }),
        client.session.active(),
      ]);
      if (current !== generation || disposed) return;
      session = info;
      selectedAgent = info.agent ?? selectedAgent;
      selectedModel = info.model ? `${info.model.providerID}:${info.model.id}` : selectedModel;
      selectedVariant = info.model?.variant ?? '';
      running = active[id]?.type === 'running';
      await Promise.all([refreshMessages(id, current), refreshRequests(id, current)]);
    } catch (cause) {
      if (current === generation) error = describe(cause);
    } finally {
      if (current === generation) loading = false;
    }
  }

  $effect(() => {
    const id = thread?.sessionId ?? null;
    const source = client;
    if (!disposed && source && (id !== selectedThreadId || source !== selectedClient)) {
      selectedClient = source;
      void activate(id);
    }
  });

  $effect(() => {
    if (session || !setup) return;
    selectedAgent ||= setup.agents.find((agent) => agent.id !== 'architect')?.id ?? '';
    selectedModel ||= setup.defaultModel
      ? `${setup.defaultModel.providerID}:${setup.defaultModel.id}`
      : '';
    selectedVariant ||= setup.defaultModel?.variant ?? '';
  });

  $effect(() => {
    if (!picked || picked.id === lastPicked) return;
    lastPicked = picked.id;
    pickedImages.add(picked.imagePath);
    files = [...files, picked.imagePath];
    draft = [draft.trim(), picked.text].filter(Boolean).join('\n\n');
    onpickedconsumed?.(picked.id);
  });

  $effect(() => {
    if (focusPrompt && focused && !busy && !loading) {
      void tick().then(() => {
        prompt?.focus();
        onpromptfocused?.();
        return undefined;
      });
    }
  });

  $effect(() => {
    if (
      !externalPrompt ||
      externalPrompt.id === lastExternalPrompt ||
      !client ||
      !inputReady ||
      busy ||
      loading
    )
      return;
    const request = externalPrompt;
    lastExternalPrompt = request.id;
    void send(request.text).then(
      () => onexternalresult?.(request.id, null),
      (cause) => onexternalresult?.(request.id, describe(cause)),
    );
  });

  $effect(() => {
    if (!mounted || !client) return;
    const controller = new AbortController();
    const source = client;
    void (async () => {
      try {
        for await (const event of source.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted || !activeID) continue;
          const id = 'data' in event && 'sessionID' in event.data ? event.data.sessionID : null;
          if (event.type.startsWith('permission.') || event.type.startsWith('form.'))
            void refreshRequests(activeID).catch((cause) => (error = describe(cause)));
          if (id !== activeID) continue;
          if (event.type === 'session.execution.started') running = true;
          if (
            event.type === 'session.execution.succeeded' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted'
          ) {
            running = false;
            if (session)
              onstatus(
                summary(session),
                event.type === 'session.execution.failed' ? 'failed' : 'done',
              );
          }
          if (event.type === 'permission.asked' && session) onstatus(summary(session), 'waiting');
          if (!refreshTimer)
            refreshTimer = setTimeout(() => {
              refreshTimer = undefined;
              if (activeID)
                void refreshMessages(activeID).catch((cause) => (error = describe(cause)));
            }, 100);
        }
      } catch (cause) {
        if (!controller.signal.aborted) error = describe(cause);
      }
    })();
    return () => controller.abort();
  });

  onMount(() => {
    disposed = false;
    mounted = true;
    return () => {
      disposed = true;
      mounted = false;
      ++generation;
      clearTimeout(refreshTimer);
      if (!sending)
        for (const path of pickedImages) void invoke('browser_remove_capture', { path });
    };
  });

  async function send(externalText?: string) {
    const external = externalText !== undefined;
    const text = (externalText ?? draft).trim();
    if (!client || !text || !inputReady || busy) {
      if (external) throw new Error('Wait for the current OpenCode turn.');
      return;
    }
    const source = client;
    const paths = external ? [] : [...files];
    const current = generation;
    let accepted = false;
    if (!external) {
      draft = '';
      files = [];
    }
    sending = true;
    stopRequested = false;
    error = '';
    try {
      let id = activeID;
      if (!id) {
        const info = await source.session.create({
          agent: selectedAgent || undefined,
          model: chosenModel
            ? {
                id: chosenModel.id,
                providerID: chosenModel.providerID,
                variant: selectedVariant || undefined,
              }
            : undefined,
          location: { directory },
          metadata: { saiHarness: true },
          title: text.length > 60 ? `${text.slice(0, 57)}…` : text,
        });
        if (current !== generation || disposed) return;
        id = info.id;
        activeID = id;
        selectedThreadId = id;
        session = info;
        oncreated(summary(info));
      }
      running = true;
      if (session) onstatus(summary(session), 'working');
      await invoke('record_turn_snapshot', { path: directory, thread: `opencode:${id}` });
      await source.session.prompt({
        sessionID: id,
        text,
        files: paths.map((path) => ({ uri: fileUri(path), name: path.split(/[\\/]/).at(-1) })),
      });
      accepted = true;
      for (const path of paths)
        if (pickedImages.delete(path)) void invoke('browser_remove_capture', { path });
      await source.session.wait({ sessionID: id });
      if (current === generation && id === activeID) {
        const latest = await source.session.get({ sessionID: id });
        session = latest;
        running = false;
        onstatus(summary(latest), latest.outcome === 'failed' ? 'failed' : 'done', !stopRequested);
        await refreshMessages(id, current);
        onactivity(summary(latest));
      }
    } catch (cause) {
      if (current === generation) {
        error = describe(cause);
        if (!external && !accepted) {
          draft = [text, draft.trim()].filter(Boolean).join('\n\n');
          files = [...paths, ...files];
        }
        running = false;
        if (session) onstatus(summary(session), 'failed');
      }
      if (external) throw cause;
    } finally {
      if (current === generation) sending = false;
      if (disposed || current !== generation)
        for (const path of pickedImages) void invoke('browser_remove_capture', { path });
      if (current !== generation) pickedImages.clear();
    }
  }

  async function stop() {
    if (!client || !activeID) return;
    stopRequested = true;
    try {
      await client.session.interrupt({ sessionID: activeID });
      running = false;
      await refreshMessages(activeID);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function chooseConfig(kind: 'agent' | 'model' | 'effort', value: string) {
    if (!client || busy) return;
    const id = activeID;
    const previous = { selectedAgent, selectedModel, selectedVariant };
    if (kind === 'agent') selectedAgent = value;
    if (kind === 'model') {
      selectedModel = value;
      selectedVariant = '';
    }
    if (kind === 'effort') selectedVariant = value;
    if (!id) return;
    try {
      if (kind === 'agent') await client.session.switchAgent({ sessionID: id, agent: value });
      else {
        const model = setup?.models.find(
          (item) => `${item.providerID}:${item.id}` === selectedModel,
        );
        if (!model) return;
        await client.session.switchModel({
          sessionID: id,
          model: {
            id: model.id,
            providerID: model.providerID,
            variant: selectedVariant || undefined,
          },
        });
      }
      session = await client.session.get({ sessionID: id });
    } catch (cause) {
      selectedAgent = previous.selectedAgent;
      selectedModel = previous.selectedModel;
      selectedVariant = previous.selectedVariant;
      error = describe(cause);
    }
  }

  async function attachFiles() {
    const selected = await open({ multiple: true, directory: false, title: 'Attach files' });
    const paths = typeof selected === 'string' ? [selected] : (selected ?? []);
    files = [...new Set([...files, ...paths])];
  }

  function removeFile(path: string) {
    files = files.filter((item) => item !== path);
    if (pickedImages.delete(path)) void invoke('browser_remove_capture', { path });
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && busy) {
      event.preventDefault();
      void stop();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }
</script>

<div class="agent-workspace opencode-pane">
  <div class="agent-header">
    <div class="agent-heading">
      <strong>OpenCode</strong><span>{session?.title ?? thread?.title ?? 'New thread'}</span>
    </div>
    <Badge tone={busy ? 'warning' : inputReady ? 'success' : 'neutral'}
      >{loading ? 'Connecting' : busy ? 'Working' : inputReady ? 'Ready' : 'Offline'}</Badge
    >
  </div>
  <div
    class="agent-conversation conversation"
    bind:this={scroll}
    aria-label="OpenCode conversation"
    onscroll={() => {
      following = nearBottom(scroll);
      if (scroll.scrollTop <= 80) void loadOlder();
    }}
  >
    {#if !messages.length && !loading}<div class="agent-welcome">
        <h1>Work with OpenCode</h1>
        <p>Describe the work. Sail will show messages, tools, and approvals here.</p>
      </div>{/if}
    {#each messages as message (message.id)}
      {#if message.type === 'user'}
        {@const attribution = coordinationMessageForText(message.text, coordinationMessages)}
        <article class="agent-message message user-message">
          <div class="avatar user-avatar">{attribution ? '↗' : 'You'}</div>
          <div class="message-body">
            <div class="message-author">{attribution ? `From ${attribution.sender}` : 'You'}</div>
            <Markdown
              source={attribution
                ? message.text.replace(coordinationPrompt(attribution), attribution.text)
                : message.text}
            />
            {#if message.files?.length}<div class="message-files">
                {#each message.files as file, index (index)}<span
                    >{file.name ??
                      (file.source.type === 'uri' ? file.source.uri : 'Attachment')}</span
                  >{/each}
              </div>{/if}
          </div>
        </article>
      {:else if message.type === 'assistant'}
        {@const text = message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')}
        <article class="agent-message message assistant-message">
          <div class="avatar agent-avatar">S.</div>
          <div class="message-body">
            <div class="message-author">{message.agent}</div>
            {#if text}<Markdown source={text} />{/if}
            {#each message.content as part, ordinal (ordinal)}
              {#if part.type === 'tool'}<details class="tool-card">
                  <summary>{part.name} · {part.state.status}</summary>
                  <pre>{part.state.status === 'streaming'
                      ? part.state.input
                      : JSON.stringify(part.state.input, null, 2)}</pre>
                  {#if part.state.status === 'completed' || part.state.status === 'error'}
                    {#each part.state.content ?? [] as item, index (index)}
                      {#if item.type === 'text'}<pre>{item.text}</pre>{:else}<p>
                          {item.name ?? item.uri}
                        </p>{/if}
                    {/each}
                  {/if}
                  {#if part.state.status === 'error'}<p class="message-error">
                      {part.state.error.message}
                    </p>{/if}
                </details>{/if}
            {/each}
            {#if message.retry}<p class="retry-state" role="status">
                Retry {message.retry.attempt}: {message.retry.error.message}
              </p>{/if}
            {#if message.error}<p class="message-error" role="alert">
                {message.error.message}
              </p>{/if}
          </div>
        </article>
      {/if}
    {/each}
    {#each coordinationMessages.filter((message) => !messages.some((item) => item.type === 'user' && item.text.includes(coordinationPrompt(message)))) as message (message.id)}
      <article class="agent-message message user-message">
        <div class="avatar user-avatar">↗</div>
        <div class="message-body">
          <div class="message-author">
            From {message.sender}{message.delivered ? '' : ' · queued'}
          </div>
          <Markdown source={message.text} />
        </div>
      </article>
    {/each}
    {#if running}<div class="agent-busy" role="status">
        OpenCode is working… <Button size="sm" variant="secondary" onclick={stop}>Stop</Button>
      </div>{/if}
  </div>
  <div class="agent-composer composer-wrap">
    <div class="composer">
      {#if error}<p class="agent-error" role="alert">{error}</p>{/if}
      <PromptPanel
        {pendingPermissions}
        {pendingForms}
        {client}
        sessionID={activeID}
        onchanged={async () => {
          if (activeID) await refreshRequests(activeID);
        }}
      />
      <textarea
        bind:this={prompt}
        data-pane-prompt
        aria-label="Message OpenCode"
        bind:value={draft}
        onkeydown={keydown}
        rows="3"
        placeholder="Message OpenCode…"
        disabled={!inputReady || busy || loading}></textarea>
      {#if files.length}<div class="attachments">
          {#each files as file (file)}<span
              >{file.split(/[\\/]/).at(-1)}<button
                aria-label={`Remove ${file.split(/[\\/]/).at(-1)}`}
                onclick={() => removeFile(file)}>×</button
              ></span
            >{/each}
        </div>{/if}
      <div class="agent-composer-footer">
        <div class="agent-picker-controls">
          <OptionPicker
            label="Agent"
            value={selectedAgent}
            options={agentChoices}
            open={pickerOpen === 'agent'}
            disabled={busy || !inputReady}
            onopen={() => (pickerOpen = 'agent')}
            onclose={() => (pickerOpen = null)}
            onchoose={(value) => void chooseConfig('agent', value)}
          />
          <OptionPicker
            label="Model"
            value={selectedModel}
            options={modelChoices}
            open={pickerOpen === 'model'}
            disabled={busy || !inputReady}
            onopen={() => (pickerOpen = 'model')}
            onclose={() => (pickerOpen = null)}
            onchoose={(value) => void chooseConfig('model', value)}
          />
          <OptionPicker
            label="Effort"
            value={selectedVariant}
            options={effortChoices}
            open={pickerOpen === 'effort'}
            disabled={busy || !inputReady}
            onopen={() => (pickerOpen = 'effort')}
            onclose={() => (pickerOpen = null)}
            onchoose={(value) => void chooseConfig('effort', value)}
          />
        </div>
        <div class="agent-actions">
          <Button variant="ghost" size="sm" onclick={attachFiles} disabled={busy || !inputReady}
            >Attach files</Button
          >
          <Button onclick={() => void send()} disabled={busy || !draft.trim() || !inputReady}
            >Send ↗</Button
          >
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .opencode-pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .opencode-pane .agent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
  }
  .opencode-pane .agent-heading {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 12px;
  }
  .opencode-pane .agent-heading span {
    overflow: hidden;
    opacity: 0.65;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .opencode-pane .agent-conversation {
    flex: 1;
    min-height: 0;
    padding-inline: 20px;
  }
  .opencode-pane .agent-message {
    width: 100%;
  }
  .opencode-pane .agent-busy {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .opencode-pane .agent-welcome {
    max-width: 650px;
    margin: 15vh auto;
    text-align: center;
  }
  .opencode-pane .agent-composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 9px 9px 10px;
  }
  .opencode-pane .agent-composer {
    flex: 0 0 auto;
    padding-inline: 20px;
  }
  .opencode-pane .agent-composer textarea {
    width: 100%;
    resize: vertical;
    box-sizing: border-box;
    background: transparent;
    color: inherit;
    border: 0;
    outline: 0;
    padding: 15px 16px;
    font: inherit;
  }
  .opencode-pane .agent-error {
    color: var(--danger, #d66);
  }
  .opencode-pane .agent-picker-controls,
  .opencode-pane .agent-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
  }
</style>
