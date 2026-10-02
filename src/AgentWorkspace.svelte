<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { Badge, Button } from '@smykla-skalski/sui';
  import Markdown from './Markdown.svelte';
  import OptionPicker from './OptionPicker.svelte';
  import {
    acp,
    updateEntries,
    type AgentEntry,
    type AgentEvent,
    type AgentConfigOption,
    type AgentAuthMethod,
    type AgentId,
    type AgentPermission,
    type AgentThread,
  } from './lib/acp';
  import type { ThreadStatus } from './lib/attention';
  import type { BrowserAttachment } from './lib/browser-pick';

  interface Props {
    agent: AgentId;
    agentName: string;
    directory: string;
    thread: AgentThread | null;
    running: boolean;
    focused?: boolean;
    focusPrompt?: boolean;
    picked?: BrowserAttachment;
    onpickedconsumed?: (id: string) => void;
    externalPrompt?: { id: string; text: string };
    onexternalresult?: (id: string, failure: string | null) => void;
    onpromptfocused?: () => void;
    oncreated: (thread: AgentThread) => void;
    onactivity: (thread: AgentThread) => void;
    onstatus: (thread: AgentThread, status: ThreadStatus, notifyOnDone?: boolean) => void;
    onterminal: (id: string) => void;
  }
  let {
    agent,
    agentName,
    directory,
    thread,
    running,
    focused = true,
    focusPrompt = false,
    picked,
    onpickedconsumed,
    externalPrompt,
    onexternalresult,
    onpromptfocused,
    oncreated,
    onactivity,
    onstatus,
    onterminal,
  }: Props = $props();
  let mounted = $state(false);
  let ready = $state(false);
  let busy = $state(false);
  let connecting = $state(false);
  let draft = $state('');
  let images = $state<BrowserAttachment[]>([]);
  let lastPicked = '';
  let lastExternalPrompt = '';

  function removeImage(image: BrowserAttachment) {
    images = images.filter((item) => item.id !== image.id);
    draft = draft.replace(image.text, '').trim();
    void invoke('browser_remove_capture', { path: image.imagePath });
  }
  let error = $state('');
  let entries = $state<AgentEntry[]>([]);
  let permissions = $state<AgentPermission[]>([]);
  let configOptions = $state<AgentConfigOption[]>([]);
  let pickerOpen = $state<'model' | 'effort' | null>(null);
  let creatingSession = $state<Promise<AgentThread> | null>(null);
  let settingConfig = $state<Promise<void> | null>(null);
  let configFailure = $state('');
  let authMethods = $state<AgentAuthMethod[]>([]);
  let authNeeded = $state(false);
  let authenticating = $state(false);
  let activeSessionId: string | null = null;
  let stopRequested = false;
  let activeTurnId: string | null = null;
  let selectedThreadId: string | null = null;
  let generation = 0;
  let scroll: HTMLDivElement;
  let prompt: HTMLTextAreaElement;
  const name = $derived(agentName);
  const isBusy = $derived(busy || running);
  const modelOption = $derived(
    configOptions.find(
      (option) => /model/i.test(`${option.id} ${option.name}`) && option.type === 'select',
    ),
  );
  const effortOption = $derived(
    configOptions.find(
      (option) =>
        /effort|reasoning|thinking/i.test(`${option.id} ${option.name}`) &&
        option.type === 'select',
    ),
  );

  $effect(() => {
    if (isBusy) pickerOpen = null;
  });

  async function focusPromptWhenReady() {
    await tick();
    if (
      !focusPrompt ||
      !ready ||
      !focused ||
      isBusy ||
      activeSessionId !== (thread?.sessionId ?? null)
    )
      return;
    prompt.focus();
    onpromptfocused?.();
  }

  $effect(() => {
    if (focusPrompt && ready && focused && !isBusy) void focusPromptWhenReady();
  });

  $effect(() => {
    if (!picked || picked.id === lastPicked) return;
    lastPicked = picked.id;
    images = [...images, picked];
    draft = [draft.trim(), picked.text].filter(Boolean).join('\n\n');
    onpickedconsumed?.(picked.id);
    void focusPromptWhenReady();
  });

  $effect(() => {
    if (!externalPrompt || externalPrompt.id === lastExternalPrompt) return;
    if (!ready) {
      if (mounted && !connecting && error) {
        lastExternalPrompt = externalPrompt.id;
        onexternalresult?.(externalPrompt.id, error);
      }
      return;
    }
    const request = externalPrompt;
    lastExternalPrompt = request.id;
    void send(request.text).then(
      () => onexternalresult?.(request.id, null),
      (cause) => onexternalresult?.(request.id, describe(cause)),
    );
  });

  function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  function markTools(status: string, from: readonly string[]) {
    entries = entries.map((entry) =>
      entry.type === 'tool' && from.includes(entry.status)
        ? Object.assign({}, entry, { status })
        : entry,
    );
  }

  async function follow() {
    await tick();
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function queuePermission(message: AgentEvent['message']) {
    const params = message.params;
    if (!params || params.sessionId !== activeSessionId || message.id == null) return;
    if (permissions.some((permission) => String(permission.id) === String(message.id))) return;
    const tool = params.toolCall;
    const title =
      tool && typeof tool === 'object' && 'title' in tool && typeof tool.title === 'string'
        ? tool.title
        : 'Allow agent action?';
    const options = Array.isArray(params.options)
      ? params.options.filter(
          (option): option is AgentPermission['options'][number] =>
            typeof option === 'object' &&
            option !== null &&
            typeof option.optionId === 'string' &&
            typeof option.name === 'string' &&
            typeof option.kind === 'string',
        )
      : [];
    permissions = [...permissions, { id: message.id, sessionId: activeSessionId!, title, options }];
    if (thread) onstatus(thread, 'waiting');
  }

  async function activate(id: string | null) {
    const current = ++generation;
    permissions = [];
    selectedThreadId = id;
    activeSessionId = id;
    entries = [];
    configOptions = [];
    pickerOpen = null;
    creatingSession = null;
    settingConfig = null;
    configFailure = '';
    authNeeded = false;
    busy = false;
    stopRequested = false;
    activeTurnId = null;
    error = '';
    ready = false;
    connecting = true;
    try {
      const info = await acp.connect(agent);
      if (current !== generation) return;
      authMethods = (info.authMethods as AgentAuthMethod[] | undefined) ?? [];
      if (id) {
        const capabilities = info.agentCapabilities;
        const canLoad =
          capabilities && typeof capabilities === 'object' && 'loadSession' in capabilities
            ? capabilities.loadSession
            : false;
        if (!canLoad) throw new Error(`${name} does not support restoring threads.`);
        const session = await acp.load(agent, directory, id);
        if (current === generation)
          configOptions = (session.configOptions as AgentConfigOption[] | undefined) ?? [];
        const waiting = await acp.pendingPermissions(agent, id);
        if (current === generation) for (const request of waiting) queuePermission(request);
      }
      if (current === generation) ready = true;
    } catch (cause) {
      if (current === generation) {
        error = describe(cause);
        authNeeded = /auth|login|sign.?in/i.test(error);
        if (thread) onstatus(thread, 'failed');
      }
    } finally {
      if (current === generation) connecting = false;
    }
    void follow();
  }

  $effect(() => {
    const id = thread?.sessionId ?? null;
    if (mounted && selectedThreadId !== id) void activate(id);
  });

  async function ensureSession(title: string): Promise<AgentThread> {
    if (activeSessionId) {
      return thread ?? { agent, sessionId: activeSessionId, directory, title, updated: Date.now() };
    }
    if (creatingSession) return creatingSession;
    const current = generation;
    creatingSession = (async () => {
      const session = await acp.create(agent, directory);
      if (current !== generation) throw new Error('Agent pane closed while creating the thread.');
      configOptions = session.configOptions ?? [];
      activeSessionId = session.sessionId;
      selectedThreadId = session.sessionId;
      const created: AgentThread = {
        agent,
        sessionId: session.sessionId,
        directory,
        title,
        updated: Date.now(),
      };
      oncreated(created);
      return created;
    })();
    try {
      return await creatingSession;
    } finally {
      creatingSession = null;
    }
  }

  async function openPicker(kind: 'model' | 'effort') {
    if (!ready || !directory || isBusy) return;
    pickerOpen = kind;
    if (activeSessionId) return;
    try {
      await ensureSession('New thread');
    } catch (cause) {
      error = describe(cause);
      authNeeded = /auth|login|sign.?in/i.test(error);
    }
  }

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentEvent>('acp-event', ({ payload }) => {
      if (disposed || payload.agent !== agent) return;
      const { message } = payload;
      if (message.method === 'sail/disconnected') {
        ready = false;
        busy = false;
        if (thread) onstatus(thread, 'failed');
        error = `${name} stopped. Reopen the thread to reconnect.`;
        return;
      }
      const params = message.params;
      if (!params || params.sessionId !== activeSessionId) return;
      if (message.method === 'sail/permission_resolved') {
        permissions = permissions.filter(
          (permission) => String(permission.id) !== String(params.requestId),
        );
        if (thread && running && permissions.length === 0) onstatus(thread, 'working');
      } else if (message.method === 'session/update') {
        const update = params.update;
        if (!update || typeof update !== 'object') return;
        const data = update as Record<string, unknown>;
        if (data.sessionUpdate === 'config_option_update' && Array.isArray(data.configOptions))
          configOptions = data.configOptions as AgentConfigOption[];
        if (data.sessionUpdate !== 'user_message_chunk' || connecting) {
          entries = updateEntries(entries, data);
        }
      } else if (message.method === 'session/request_permission' && message.id != null) {
        queuePermission(message);
      }
    })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else unlisten = unsubscribe;
        if (!disposed) {
          selectedThreadId = thread?.sessionId ?? null;
          mounted = true;
          void activate(selectedThreadId);
        }
        return undefined;
      })
      .catch((cause) => {
        if (!disposed) error = `Could not subscribe to agent events: ${describe(cause)}`;
      });
    return () => {
      disposed = true;
      generation++;
      unlisten?.();
      images.forEach((image) => void invoke('browser_remove_capture', { path: image.imagePath }));
    };
  });

  async function send(externalText?: string) {
    const external = externalText !== undefined;
    const text = (externalText ?? draft).trim();
    const command = text.toLowerCase();
    if (
      !external &&
      !isBusy &&
      ready &&
      directory &&
      (command === '/model' || command === '/effort')
    ) {
      draft = '';
      await openPicker(command.slice(1) as 'model' | 'effort');
      return;
    }
    if (!text || !ready || isBusy || !directory) {
      if (external) throw new Error('Wait for the current agent turn.');
      return;
    }
    const sentImages = external ? [] : [...images];
    const current = generation;
    const turnId = crypto.randomUUID();
    activeTurnId = turnId;
    let activityThread = thread;
    let finalStatus: ThreadStatus = 'done';
    let notifyOnDone = true;
    let keepImages = false;
    busy = true;
    if (activityThread) onstatus(activityThread, 'working');
    stopRequested = false;
    error = '';
    if (!external) {
      draft = '';
      images = [];
    }
    try {
      if (!activeSessionId) activityThread = await ensureSession(text.slice(0, 60));
      else if (activityThread?.title === 'New thread')
        activityThread = { ...activityThread, title: text.slice(0, 60) };
      if (current !== generation) return;
      if (activityThread) onstatus(activityThread, 'working');
      if (settingConfig) await settingConfig;
      if (configFailure) throw new Error(configFailure);
      if (activityThread) onactivity(activityThread);
      const id = activeSessionId;
      if (stopRequested) {
        notifyOnDone = false;
        if (external) throw new Error('Agent turn was cancelled.');
        if (current === generation) {
          draft = [text, draft.trim()].filter(Boolean).join('\n\n');
          images = [...sentImages, ...images];
          keepImages = true;
        }
        return;
      }
      entries = [...entries, { id: crypto.randomUUID(), type: 'user', text }];
      void follow();
      const result = await acp.prompt(
        agent,
        id!,
        text,
        turnId,
        sentImages.map((item) => item.imagePath),
      );
      if (result.stopReason === 'cancelled' || stopRequested) notifyOnDone = false;
      if (external && !notifyOnDone) throw new Error('Agent turn was cancelled.');
      if (current === generation && stopRequested)
        markTools(result.stopReason === 'cancelled' ? 'cancelled' : 'status unconfirmed', [
          'pending',
          'in_progress',
          'stopping',
        ]);
      if (activityThread) onactivity({ ...activityThread, updated: Date.now() });
    } catch (cause) {
      finalStatus = 'failed';
      if (current === generation) {
        error = describe(cause);
        authNeeded = /auth|login|sign.?in/i.test(error);
        if (!external) {
          draft = [text, draft.trim()].filter(Boolean).join('\n\n');
          images = [...sentImages, ...images];
          keepImages = true;
        }
        if (stopRequested) markTools('status unconfirmed', ['stopping']);
      }
      if (external) throw cause;
    } finally {
      if (!keepImages)
        sentImages.forEach(
          (image) => void invoke('browser_remove_capture', { path: image.imagePath }),
        );
      if (activeTurnId === turnId) activeTurnId = null;
      if (activityThread) onstatus(activityThread, finalStatus, notifyOnDone);
      if (current === generation) busy = false;
    }
  }

  async function stop() {
    stopRequested = true;
    if (!activeSessionId) return;
    const current = generation;
    const sessionId = activeSessionId;
    const pending = permissions;
    try {
      await acp.cancel(agent, sessionId, activeTurnId);
      await Promise.all(pending.map((permission) => acp.permission(agent, permission.id, null)));
      if (current !== generation || activeSessionId !== sessionId) return;
      permissions = [];
      markTools('stopping', ['pending', 'in_progress']);
    } catch (cause) {
      if (current === generation && activeSessionId === sessionId) error = describe(cause);
    }
  }

  async function answer(permission: AgentPermission, optionId: string) {
    const lastRequest = permissions.length === 1 && permissions[0]?.id === permission.id;
    if (thread && lastRequest) onstatus(thread, 'working');
    try {
      await acp.permission(agent, permission.id, optionId);
      permissions = permissions.filter((item) => item.id !== permission.id);
    } catch (cause) {
      error = describe(cause);
      if (thread && lastRequest) {
        const pending = await acp.pendingPermissions(agent, permission.sessionId).catch(() => []);
        if (pending.some((message) => message.id === permission.id)) onstatus(thread, 'waiting');
      }
    }
  }

  function setConfig(configId: string, value: string) {
    if (!activeSessionId || isBusy) return;
    configFailure = '';
    const sessionId = activeSessionId;
    const previous = settingConfig;
    const task = (async () => {
      if (previous) await previous;
      try {
        const result = await acp.setConfig(agent, sessionId, configId, value);
        if (activeSessionId !== sessionId) return;
        configFailure = '';
        error = '';
        configOptions =
          result.configOptions ??
          configOptions.map((option) =>
            option.id === configId ? Object.assign({}, option, { currentValue: value }) : option,
          );
      } catch (cause) {
        if (activeSessionId !== sessionId) return;
        configFailure = describe(cause);
        error = configFailure;
      }
    })();
    settingConfig = task;
    void task.finally(() => {
      if (settingConfig === task) settingConfig = null;
    });
  }

  async function authenticate(methodId: string) {
    authenticating = true;
    error = '';
    try {
      await acp.authenticate(agent, methodId);
      authNeeded = false;
      if (activeSessionId) await activate(activeSessionId);
      else if (pickerOpen) await ensureSession('New thread');
      else ready = true;
    } catch (cause) {
      error = describe(cause);
    } finally {
      authenticating = false;
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function keydownWorkspace(event: KeyboardEvent) {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      !isBusy ||
      !focused ||
      document.querySelector('dialog[open]')
    )
      return;
    event.preventDefault();
    void stop();
  }
</script>

<svelte:window onkeydown={keydownWorkspace} />
<div class="agent-workspace">
  <div class="agent-header">
    <div class="agent-heading">
      <strong>{name}</strong><span>{thread?.title ?? 'New thread'}</span>
    </div>
    <div class="agent-config">
      {#each configOptions.filter((option) => option.type === 'select' && Array.isArray(option.options) && option.id !== modelOption?.id && option.id !== effortOption?.id) as option (option.id)}
        <label
          >{option.name}<select
            value={option.currentValue}
            disabled={isBusy}
            onchange={(event) => setConfig(option.id, event.currentTarget.value)}
          >
            {#each option.options as choice (choice.value)}<option value={choice.value}
                >{choice.name}</option
              >{/each}
          </select></label
        >
      {/each}
    </div>
    <Badge tone={isBusy ? 'warning' : ready ? 'success' : 'neutral'}
      >{connecting ? 'Connecting' : isBusy ? 'Working' : ready ? 'Ready' : 'Offline'}</Badge
    >
  </div>
  <div
    class="agent-conversation conversation"
    bind:this={scroll}
    aria-label={`${name} conversation`}
  >
    {#if entries.length === 0 && !connecting}
      <div class="agent-welcome">
        <h1>Work with {name}</h1>
        <p>Describe the work. Sail will show messages, tools, and approvals here.</p>
      </div>
    {/if}
    {#each entries as entry (entry.id)}
      {#if entry.type === 'tool'}
        <details class="agent-tool tool-card">
          <summary>{entry.title} · {entry.status}</summary
          >{#if entry.content}<pre>{entry.content}</pre>{/if}
          {#each entry.terminalIds as terminalId (terminalId)}
            <button onclick={() => onterminal(terminalId)}>Open terminal</button>
          {/each}
        </details>
      {:else}
        <article
          class:user-message={entry.type === 'user'}
          class:assistant-message={entry.type !== 'user'}
          class:thought={entry.type === 'thought'}
          class="agent-message message"
        >
          <div
            class:agent-avatar={entry.type !== 'user'}
            class:user-avatar={entry.type === 'user'}
            class="avatar"
          >
            {entry.type === 'user' ? 'You' : 'S.'}
          </div>
          <div class="message-body">
            <div class="message-author">
              {entry.type === 'user'
                ? 'You'
                : entry.type === 'thought'
                  ? `${name} · thinking`
                  : name}
            </div>
            <Markdown source={entry.text} />
          </div>
        </article>
      {/if}
    {/each}
    {#if isBusy}<div class="agent-busy" role="status">
        {name} is working… <Button size="sm" variant="secondary" onclick={stop}>Stop</Button>
      </div>{/if}
  </div>
  <div class="agent-composer composer-wrap">
    <div class="composer">
      {#if error}<p class="agent-error" role="alert">
          {error} <button onclick={() => void activate(activeSessionId)}>Retry</button>
        </p>{/if}
      {#if authNeeded}
        <div class="agent-auth" role="group" aria-label="Agent sign in">
          {#each authMethods.filter((method) => method.type !== 'terminal') as method (method.id)}
            <Button
              size="sm"
              onclick={() => authenticate(method.id)}
              disabled={authenticating}
              loading={authenticating}>Sign in with {method.name}</Button
            >
          {:else}
            <span>Sign in with {name}, then choose Retry.</span>
          {/each}
        </div>
      {/if}
      {#each permissions as permission (String(permission.id))}
        <div
          class="agent-permission"
          role="group"
          aria-label="Agent permission request"
          data-request-id={permission.id}
          data-session-id={permission.sessionId}
          data-agent-id={agent}
          tabindex="-1"
        >
          <strong>{permission.title}</strong>
          <div>
            {#each permission.options as option (option.optionId)}<Button
                size="sm"
                variant={option.kind.startsWith('allow') ? 'primary' : 'secondary'}
                onclick={() => answer(permission, option.optionId)}>{option.name}</Button
              >{/each}
          </div>
        </div>
      {/each}
      <textarea
        bind:this={prompt}
        data-pane-prompt
        aria-label={`Message ${name}`}
        bind:value={draft}
        onkeydown={keydown}
        rows="3"
        placeholder={`Message ${name}…`}
        disabled={!ready || isBusy || !directory}></textarea>
      {#if images.length}<div class="attachments">
          {#each images as image (image.id)}<span
              >📷 {image.imagePath.split(/[\\/]/).at(-1)}
              <button aria-label="Remove picked element" onclick={() => removeImage(image)}
                >×</button
              ></span
            >{/each}
        </div>{/if}
      <div class="agent-picker-controls">
        <OptionPicker
          label="Model"
          value={modelOption?.currentValue}
          options={modelOption?.options ?? []}
          open={pickerOpen === 'model'}
          disabled={!ready || isBusy || !directory}
          loading={!!creatingSession}
          onopen={() => void openPicker('model')}
          onclose={() => (pickerOpen = null)}
          onchoose={(value) => {
            if (modelOption) void setConfig(modelOption.id, value);
          }}
        />
        <OptionPicker
          label="Effort"
          value={effortOption?.currentValue}
          options={effortOption?.options ?? []}
          open={pickerOpen === 'effort'}
          disabled={!ready || isBusy || !directory}
          loading={!!creatingSession}
          onopen={() => void openPicker('effort')}
          onclose={() => (pickerOpen = null)}
          onchoose={(value) => {
            if (effortOption) void setConfig(effortOption.id, value);
          }}
        />
      </div>
      <div class="agent-actions composer-bottom">
        <span>Enter to send · Shift+Enter for newline</span>
        <Button
          onclick={() => void send()}
          disabled={!ready || isBusy || !draft.trim()}
          loading={isBusy}>Send ↗</Button
        >
      </div>
    </div>
  </div>
</div>

<style>
  .agent-workspace {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }
  .agent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
  }
  .agent-header div {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .agent-header .agent-heading {
    min-width: 0;
    flex: 1;
  }
  .agent-heading strong {
    flex: none;
  }
  .agent-header span {
    opacity: 0.65;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-picker-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .agent-header .agent-config {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-left: auto;
    margin-right: 12px;
  }
  .agent-config label {
    display: flex;
    gap: 5px;
    align-items: center;
    font-size: 0.8rem;
  }
  .agent-config select {
    max-width: 180px;
  }
  .agent-conversation {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .agent-welcome {
    max-width: 650px;
    margin: 15vh auto;
    text-align: center;
  }
  .agent-message {
    max-width: 740px;
    margin: 0 auto;
  }
  .agent-message.thought {
    opacity: 0.65;
  }
  .agent-tool {
    max-width: 740px;
    margin: 0 auto 16px;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .agent-tool summary {
    cursor: pointer;
  }
  .agent-tool pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .agent-busy {
    max-width: 820px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .agent-composer {
    flex: 0 0 auto;
  }
  .agent-composer textarea {
    width: 100%;
    resize: vertical;
    box-sizing: border-box;
    background: var(--surface-1);
    color: inherit;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    font: inherit;
  }
  .agent-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
  }
  .agent-error {
    color: var(--danger, #d66);
  }
  .agent-permission {
    max-width: 820px;
    margin: 0 auto 10px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .agent-permission div {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
</style>
