<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { Badge, Button } from '@smykla-skalski/sui';
  import Markdown from './Markdown.svelte';
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

  interface Props {
    agent: AgentId;
    agentName: string;
    directory: string;
    thread: AgentThread | null;
    oncreated: (thread: AgentThread) => void;
    onactivity: (thread: AgentThread) => void;
  }
  let { agent, agentName, directory, thread, oncreated, onactivity }: Props = $props();
  let mounted = $state(false);
  let ready = $state(false);
  let busy = $state(false);
  let connecting = $state(false);
  let draft = $state('');
  let error = $state('');
  let entries = $state<AgentEntry[]>([]);
  let permissions = $state<AgentPermission[]>([]);
  let configOptions = $state<AgentConfigOption[]>([]);
  let authMethods = $state<AgentAuthMethod[]>([]);
  let authNeeded = $state(false);
  let authenticating = $state(false);
  let activeSessionId: string | null = null;
  let selectedThreadId: string | null = null;
  let generation = 0;
  let scroll: HTMLDivElement;
  const name = $derived(agentName);

  function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
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
  }

  async function activate(id: string | null) {
    const current = ++generation;
    const abandoned = permissions;
    permissions = [];
    for (const permission of abandoned) void acp.permission(agent, permission.id, null);
    selectedThreadId = id;
    activeSessionId = id;
    entries = [];
    configOptions = [];
    authNeeded = false;
    busy = false;
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

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentEvent>('acp-event', ({ payload }) => {
      if (disposed || payload.agent !== agent) return;
      const { message } = payload;
      if (message.method === 'sail/disconnected') {
        ready = false;
        busy = false;
        error = `${name} stopped. Reopen the thread to reconnect.`;
        return;
      }
      const params = message.params;
      if (!params || params.sessionId !== activeSessionId) return;
      if (message.method === 'session/update') {
        const update = params.update;
        if (!update || typeof update !== 'object') return;
        const data = update as Record<string, unknown>;
        if (data.sessionUpdate === 'config_option_update' && Array.isArray(data.configOptions))
          configOptions = data.configOptions as AgentConfigOption[];
        if (data.sessionUpdate !== 'user_message_chunk' || connecting) {
          entries = updateEntries(entries, data);
          void follow();
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
      for (const permission of permissions) void acp.permission(agent, permission.id, null);
    };
  });

  async function send() {
    const text = draft.trim();
    if (!text || !ready || busy || !directory) return;
    const current = generation;
    let activityThread = thread;
    busy = true;
    error = '';
    draft = '';
    try {
      if (!activeSessionId) {
        const session = await acp.create(agent, directory);
        if (current !== generation) return;
        configOptions = session.configOptions ?? [];
        activeSessionId = session.sessionId;
        selectedThreadId = session.sessionId;
        const created: AgentThread = {
          agent,
          sessionId: session.sessionId,
          directory,
          title: text.slice(0, 60),
          updated: Date.now(),
        };
        activityThread = created;
        oncreated(created);
      }
      const id = activeSessionId;
      entries = [...entries, { id: crypto.randomUUID(), type: 'user', text }];
      void follow();
      await acp.prompt(agent, id!, text);
      if (activityThread) onactivity({ ...activityThread, updated: Date.now() });
    } catch (cause) {
      if (current === generation) {
        error = describe(cause);
        authNeeded = /auth|login|sign.?in/i.test(error);
        if (!activeSessionId) draft = text;
      }
    } finally {
      if (current === generation) busy = false;
    }
  }

  async function stop() {
    if (!activeSessionId) return;
    try {
      await acp.cancel(agent, activeSessionId);
      await Promise.all(
        permissions.map((permission) => acp.permission(agent, permission.id, null)),
      );
      permissions = [];
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function answer(permission: AgentPermission, optionId: string) {
    try {
      await acp.permission(agent, permission.id, optionId);
      permissions = permissions.filter((item) => item.id !== permission.id);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function setConfig(configId: string, value: string) {
    if (!activeSessionId) return;
    try {
      const result = await acp.setConfig(agent, activeSessionId, configId, value);
      configOptions =
        result.configOptions ??
        configOptions.map((option) =>
          option.id === configId ? Object.assign({}, option, { currentValue: value }) : option,
        );
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function authenticate(methodId: string) {
    authenticating = true;
    error = '';
    try {
      await acp.authenticate(agent, methodId);
      authNeeded = false;
      if (activeSessionId) await activate(activeSessionId);
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
</script>

<div class="agent-workspace">
  <div class="agent-header">
    <div><strong>{name}</strong><span>{thread?.title ?? 'New thread'}</span></div>
    <div class="agent-config">
      {#each configOptions.filter((option) => option.type === 'select' && Array.isArray(option.options)) as option (option.id)}
        <label
          >{option.name}<select
            value={option.currentValue}
            disabled={busy}
            onchange={(event) => void setConfig(option.id, event.currentTarget.value)}
          >
            {#each option.options as choice (choice.value)}<option value={choice.value}
                >{choice.name}</option
              >{/each}
          </select></label
        >
      {/each}
    </div>
    <Badge tone={ready ? 'success' : 'neutral'}
      >{connecting ? 'Connecting' : ready ? 'Ready' : 'Offline'}</Badge
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
    {#if busy}<div class="agent-busy" role="status">
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
        <div class="agent-permission" role="group" aria-label="Agent permission request">
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
        aria-label={`Message ${name}`}
        bind:value={draft}
        onkeydown={keydown}
        rows="3"
        placeholder={`Message ${name}…`}
        disabled={!ready || busy || !directory}></textarea>
      <div class="agent-actions composer-bottom">
        <span>Enter to send · Shift+Enter for newline</span><Button
          onclick={send}
          disabled={!ready || busy || !draft.trim()}
          loading={busy}>Send ↗</Button
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
  .agent-header span {
    opacity: 0.65;
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
  .agent-actions span {
    opacity: 0.6;
    font-size: 0.8rem;
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
