<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-dialog';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { isSessionNotFoundError } from '@opencode/client';
  import { Badge, Button } from '@smykla-skalski/sui';
  import PlanPanel from './PlanPanel.svelte';
  import {
    connect,
    type OpenCodeClient,
    type RuntimeInfo,
    type SessionInfo,
    type SessionMessageInfo,
  } from './lib/opencode';
  import { getPlan, type PlanSnapshot } from './lib/plan';
  import { inspectRepository, type SetupCheck, type SetupReport } from './lib/onboarding';

  let dark = $state(localStorage.getItem('sai-theme') === 'dark');
  let directory = $state(localStorage.getItem('sai-directory') ?? '');
  let binaryPath = $state(localStorage.getItem('sai-opencode-bin') ?? '');
  let appliedBinaryPath = localStorage.getItem('sai-opencode-bin') ?? '';
  let activeBinary = $state('');
  let runtimeSettingsOpen = $state(false);
  let runtimeState = $state<'starting' | 'connected' | 'error'>('starting');
  let runtimeError = $state('');
  let agentReady = $state(false);
  let setup = $state<SetupReport | null>(null);
  let setupError = $state('');
  let setupLoading = $state(false);
  let setupOpen = $state(true);
  let sessions = $state<SessionInfo[]>([]);
  let selectedSession = $state<SessionInfo | null>(null);
  let sessionSearch = $state('');
  let sessionCursor = $state<string | undefined>(undefined);
  let nextSessionCursor = $state<string | null>(null);
  let previousSessionCursor = $state<string | null>(null);
  let sessionLoading = $state(false);
  let activeSessionIDs = $state<string[]>([]);
  let editingSessionID = $state<string | null>(null);
  let editedTitle = $state('');
  let sessionID = $state<string | null>(null);
  let messages = $state<SessionMessageInfo[]>([]);
  let snapshot = $state<PlanSnapshot>({ plan: null, questions: null });
  let draft = $state('');
  let sending = $state(false);
  let running = $state(false);
  let error = $state('');
  let chatEnd: HTMLDivElement;
  let client = $state<OpenCodeClient | null>(null);
  let eventController: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let connecting = $state(false);
  let disposed = false;
  let hasConnected = false;
  let pendingPermissions = $state(0);
  let selection = 0;
  let sessionRefresh = 0;

  let currentSession = $derived(
    sessions.find((session) => session.id === sessionID) ??
      (selectedSession?.id === sessionID ? selectedSession : undefined),
  );
  let visibleSessions = $derived(
    selectedSession && !sessions.some((session) => session.id === selectedSession?.id)
      ? [selectedSession, ...sessions]
      : sessions,
  );
  let chatMessages = $derived(
    messages.filter((message) => message.type === 'user' || message.type === 'assistant'),
  );
  let canSend = $derived(
    runtimeState === 'connected' &&
      !connecting &&
      !!client &&
      !!directory &&
      agentReady &&
      !!draft.trim() &&
      !sending,
  );

  function setupRows(report: SetupReport): [string, SetupCheck][] {
    return [
      ['OpenCode location', report.location],
      ['Plan-review plugin', report.plugin],
      ['Architect agent', report.architect],
      ['Plan RPC', report.rpc],
      ['Provider and model', report.model],
    ];
  }

  function setTheme(value: boolean) {
    dark = value;
    document.documentElement.dataset.suiTheme = value ? 'dark' : 'light';
    localStorage.setItem('sai-theme', value ? 'dark' : 'light');
  }

  onMount(() => {
    setTheme(dark);
    void initialize();
    healthTimer = setInterval(() => void checkRuntime(), 5000);
    return () => {
      disposed = true;
      eventController?.abort();
      clearTimeout(refreshTimer);
      clearTimeout(recoveryTimer);
      clearInterval(healthTimer);
    };
  });

  async function initialize() {
    if (!isTauri()) {
      runtimeState = 'error';
      runtimeError = 'Open the desktop app with mise run dev to start OpenCode.';
      return;
    }
    await recoverRuntime();
  }

  async function activateRuntime(info: RuntimeInfo) {
    const nextClient = connect(info);
    const server = await nextClient.server.info({ signal: AbortSignal.timeout(5000) });
    if (!server.version.startsWith('2.'))
      throw new Error('OpenCode v2 is required. Choose a compatible binary in settings.');
    if (disposed) return;
    clearTimeout(recoveryTimer);
    eventController?.abort();
    client = nextClient;
    activeBinary = info.binaryPath;
    runtimeState = 'connected';
    runtimeError = '';
    hasConnected = true;
    await resync().catch((cause) => {
      error = describe(cause);
    });
    eventController = new AbortController();
    connecting = false;
    void watchEvents(nextClient, eventController.signal);
  }

  async function recoverRuntime() {
    if (connecting || disposed) return;
    connecting = true;
    eventController?.abort();
    clearTimeout(recoveryTimer);
    runtimeState = 'starting';
    runtimeError = '';
    try {
      const info = await invoke<RuntimeInfo>('start_runtime', {
        binaryPath: appliedBinaryPath || null,
        restart: false,
      });
      await activateRuntime(info);
    } catch (cause) {
      if (disposed) return;
      client = null;
      runtimeState = 'error';
      runtimeError = describe(cause);
      runtimeSettingsOpen = true;
      if (hasConnected) recoveryTimer = setTimeout(() => void recoverRuntime(), 5000);
    } finally {
      connecting = false;
    }
  }

  async function retryRuntime() {
    if (connecting || disposed) return;
    connecting = true;
    clearTimeout(recoveryTimer);
    const candidate = binaryPath.trim();
    try {
      const info = await invoke<RuntimeInfo>('start_runtime', {
        binaryPath: candidate || null,
        restart: true,
      });
      await activateRuntime(info);
      appliedBinaryPath = candidate;
      localStorage.setItem('sai-opencode-bin', candidate);
    } catch (cause) {
      runtimeError = describe(cause);
      runtimeSettingsOpen = true;
      if (runtimeState !== 'connected' && hasConnected)
        recoveryTimer = setTimeout(() => void recoverRuntime(), 5000);
    } finally {
      connecting = false;
    }
  }

  async function checkRuntime() {
    if (connecting || runtimeState !== 'connected' || !client) return;
    try {
      await client.server.info({ signal: AbortSignal.timeout(3000) });
    } catch {
      await recoverRuntime();
    }
  }

  async function resync() {
    if (!client || !directory) return;
    const current = selection;
    await refreshSetup(directory);
    if (current !== selection) return;
    if (!agentReady) return;
    const path = directory;
    await refreshSessions();
    if (current !== selection || path !== directory) return;
    const saved = localStorage.getItem(`sai-session:${path}`);
    const initial = sessionID ?? saved ?? sessions[0]?.id;
    if (initial && initial !== sessionID) {
      if (!(await restoreSession(initial))) {
        if (current !== selection || path !== directory) return;
        localStorage.removeItem(`sai-session:${path}`);
        if (sessions[0]) await selectSession(sessions[0].id);
      }
    } else if (initial) {
      await refreshSession(initial);
    }
    const [permissions, active] = await Promise.all([
      client.permission.request.list({ location: { directory: path } }),
      client.session.active(),
    ]);
    if (path !== directory) return;
    pendingPermissions = permissions.data.filter(
      (request) => request.sessionID === sessionID,
    ).length;
    running = !!sessionID && active[sessionID]?.type === 'running';
  }

  async function chooseProject() {
    const selected = await open({ directory: true, multiple: false, title: 'Choose a repository' });
    if (typeof selected === 'string') await loadProject(selected);
  }

  async function loadProject(path: string) {
    if (!client) return;
    error = '';
    const current = ++selection;
    ++sessionRefresh;
    agentReady = false;
    setupOpen = true;
    sessionID = null;
    selectedSession = null;
    sessions = [];
    sessionSearch = '';
    sessionCursor = undefined;
    nextSessionCursor = null;
    previousSessionCursor = null;
    messages = [];
    running = false;
    pendingPermissions = 0;
    snapshot = { plan: null, questions: null };
    if (!(await refreshSetup(path)) || current !== selection) return;
    if (!agentReady) return;
    try {
      await refreshSessions();
      if (current !== selection) return;
      const saved = localStorage.getItem(`sai-session:${directory}`);
      if (saved && (await restoreSession(saved))) return;
      if (current !== selection) return;
      if (saved) localStorage.removeItem(`sai-session:${directory}`);
      if (sessions[0]) await selectSession(sessions[0].id);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function refreshSetup(path = directory) {
    if (!client || !path) return false;
    setupLoading = true;
    setupError = '';
    const current = selection;
    try {
      const report = await inspectRepository(client, path);
      if (current !== selection) return false;
      directory = report.repository;
      localStorage.setItem('sai-directory', report.repository);
      setup = report;
      agentReady = report.ready;
      setupOpen = !report.ready;
      return true;
    } catch (cause) {
      if (current !== selection) return false;
      setupError = describe(cause);
      setupOpen = true;
      agentReady = false;
      return false;
    } finally {
      if (current === selection) setupLoading = false;
    }
  }

  async function restartSetup() {
    if (connecting || !client) return;
    connecting = true;
    setupLoading = true;
    setupError = '';
    clearTimeout(recoveryTimer);
    try {
      const active = await client.session.active();
      if (sending || Object.values(active).some((session) => session.type === 'running')) {
        setupError = 'Wait for active OpenCode sessions to finish before restarting.';
        return;
      }
      const info = await invoke<RuntimeInfo>('start_runtime', {
        binaryPath: appliedBinaryPath || null,
        restart: true,
      });
      await activateRuntime(info);
      setupOpen = true;
    } catch (cause) {
      setupError = describe(cause);
    } finally {
      connecting = false;
      setupLoading = false;
    }
  }

  async function refreshSessions() {
    if (!client || !directory) return;
    const path = directory;
    const search = sessionSearch.trim();
    const cursor = sessionCursor;
    const current = ++sessionRefresh;
    sessionLoading = true;
    try {
      const [result, active] = await Promise.all([
        client.session.list({
          directory: path,
          limit: 25,
          order: 'desc',
          ...(search ? { search } : {}),
          ...(cursor ? { cursor } : {}),
        }),
        client.session.active(),
      ]);
      if (
        path !== directory ||
        current !== sessionRefresh ||
        search !== sessionSearch.trim() ||
        cursor !== sessionCursor
      )
        return;
      sessions = result.data.filter(
        (session) =>
          (session.agent === 'architect' || session.metadata?.saiHarness === true) &&
          !session.parentID,
      );
      nextSessionCursor = result.cursor.next ?? null;
      previousSessionCursor = result.cursor.previous ?? null;
      activeSessionIDs = Object.keys(active);
      running = !!sessionID && activeSessionIDs.includes(sessionID);
      const selected = sessions.find((session) => session.id === sessionID);
      if (selected) selectedSession = selected;
      else if (sessionID) {
        const requestedID = sessionID;
        try {
          const info = await client.session.get({ sessionID: requestedID });
          if (path === directory && current === sessionRefresh && requestedID === sessionID)
            selectedSession = info;
        } catch (cause) {
          if (
            path === directory &&
            current === sessionRefresh &&
            requestedID === sessionID &&
            isSessionNotFoundError(cause)
          ) {
            clearSelectedSession();
          }
        }
      }
    } finally {
      if (current === sessionRefresh) sessionLoading = false;
    }
  }

  async function restoreSession(id: string) {
    if (!client) return false;
    const path = directory;
    const current = selection;
    try {
      const info = await client.session.get({ sessionID: id });
      if (
        current !== selection ||
        path !== directory ||
        info.location.directory !== path ||
        info.parentID
      )
        return false;
      if (info.agent !== 'architect' && info.metadata?.saiHarness !== true) return false;
      selectedSession = info;
      await selectSession(id);
      return true;
    } catch (cause) {
      if (!isSessionNotFoundError(cause)) error = describe(cause);
      return false;
    }
  }

  function clearSelectedSession() {
    sessionID = null;
    selectedSession = null;
    messages = [];
    snapshot = { plan: null, questions: null };
    running = false;
    pendingPermissions = 0;
    localStorage.removeItem(`sai-session:${directory}`);
  }

  async function selectSession(id: string) {
    const current = ++selection;
    sessionID = id;
    selectedSession = sessions.find((session) => session.id === id) ?? selectedSession;
    messages = [];
    running = false;
    pendingPermissions = 0;
    snapshot = { plan: null, questions: null };
    error = '';
    localStorage.setItem(`sai-session:${directory}`, id);
    await refreshSession(id, current);
  }

  async function newPlan() {
    if (!client || !directory || !agentReady) return;
    try {
      const session = await client.session.create({
        agent: 'architect',
        location: { directory },
        metadata: { saiHarness: true },
        title: 'New plan',
      });
      sessionSearch = '';
      sessionCursor = undefined;
      await refreshSessions();
      selectedSession = session;
      await selectSession(session.id);
    } catch (cause) {
      error = describe(cause);
    }
  }

  function changeSearch() {
    sessionCursor = undefined;
    void refreshSessions().catch((cause) => {
      error = describe(cause);
    });
  }

  function changePage(cursor: string | null) {
    if (!cursor) return;
    sessionCursor = cursor;
    void refreshSessions().catch((cause) => {
      error = describe(cause);
    });
  }

  function startRename(session: SessionInfo) {
    editingSessionID = session.id;
    editedTitle = session.title ?? '';
  }

  async function saveRename() {
    if (!client || !editingSessionID) return;
    const title = editedTitle.trim();
    if (!title) {
      error = 'Enter a session title.';
      return;
    }
    try {
      await client.session.update({ sessionID: editingSessionID, title });
      editingSessionID = null;
      await refreshSessions();
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function removeSession(session: SessionInfo) {
    if (!client) return;
    const confirmed = await ask(
      `Delete “${session.title ?? 'Untitled plan'}”? This cannot be undone.`,
      {
        title: 'Delete plan session',
        kind: 'warning',
      },
    );
    if (!confirmed) return;
    try {
      await client.session.remove({ sessionID: session.id });
      if (session.id === sessionID) clearSelectedSession();
      await refreshSessions();
      if (!sessions.length && previousSessionCursor) changePage(previousSessionCursor);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function refreshSession(id = sessionID, current = selection) {
    if (!client || !id || !directory) return;
    try {
      const [history, plan, permissions] = await Promise.all([
        client.message.list({ sessionID: id, limit: 100, order: 'asc' }),
        getPlan(client, directory, id),
        client.permission.list({ sessionID: id }),
      ]);
      if (current !== selection || id !== sessionID) return;
      messages = history.data;
      snapshot = plan;
      pendingPermissions = permissions.length;
      await tick();
      chatEnd?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    } catch (cause) {
      if (current === selection) error = describe(cause);
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshSession(), 120);
  }

  async function watchEvents(source: OpenCodeClient, signal: AbortSignal) {
    try {
      for await (const event of source.event.subscribe({ signal })) {
        if (signal.aborted) return;
        if (event.type === 'server.connected') {
          void resync().catch((cause) => {
            error = describe(cause);
          });
        }
        if (
          [
            'session.created',
            'session.renamed',
            'session.deleted',
            'session.agent.selected',
            'session.execution.started',
            'session.execution.succeeded',
            'session.execution.failed',
            'session.execution.interrupted',
          ].includes(event.type)
        )
          void refreshSessions().catch((cause) => {
            error = describe(cause);
          });
        const eventSession =
          'data' in event && 'sessionID' in event.data ? event.data.sessionID : undefined;
        if (
          eventSession === sessionID ||
          (event.type === 'rpc.planreview.changed' && event.location?.directory === directory)
        ) {
          if (event.type === 'session.execution.started') running = true;
          if (
            [
              'session.execution.succeeded',
              'session.execution.failed',
              'session.execution.interrupted',
            ].includes(event.type)
          )
            running = false;
          scheduleRefresh();
        }
        if (event.type === 'permission.asked' || event.type === 'permission.replied')
          scheduleRefresh();
      }
    } catch {
      // A new subscription reloads missed state after the live stream fails.
    }
    if (!signal.aborted) {
      runtimeState = 'starting';
      recoveryTimer = setTimeout(() => void recoverRuntime(), 1500);
    }
  }

  async function send() {
    if (!client || !canSend) return;
    const text = draft.trim();
    draft = '';
    sending = true;
    error = '';
    try {
      let id = sessionID;
      if (!id) {
        const session = await client.session.create({
          agent: 'architect',
          location: { directory },
          metadata: { saiHarness: true },
          title: text.length > 60 ? `${text.slice(0, 57)}…` : text,
        });
        id = session.id;
        await refreshSessions();
        selectedSession = session;
        await selectSession(id);
      } else if (currentSession?.title === 'New plan') {
        await client.session.update({
          sessionID: id,
          title: text.length > 60 ? `${text.slice(0, 57)}…` : text,
        });
        await refreshSessions();
      }
      running = true;
      await client.session.prompt({ sessionID: id, text });
      await refreshSession(id);
    } catch (cause) {
      draft = text;
      running = false;
      error = describe(cause);
    } finally {
      sending = false;
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function describe(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (typeof cause === 'object' && cause && 'message' in cause) return String(cause.message);
    return String(cause);
  }
  function assistantText(message: SessionMessageInfo): string {
    return message.type === 'assistant'
      ? message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
      : '';
  }
  function toolsUsed(message: SessionMessageInfo): string[] {
    return message.type === 'assistant'
      ? message.content.filter((part) => part.type === 'tool').map((part) => part.name)
      : [];
  }
</script>

<svelte:head><title>SAI Harness · Plan workspace</title></svelte:head>
<div class="app-shell">
  <aside class="sidebar" aria-label="Plan sessions">
    <div class="brand"><span class="brand-mark">S.</span><span>SAI Harness</span></div>
    <div class="project-switcher">
      <span class="label">PROJECT</span><button
        class="project-button"
        onclick={chooseProject}
        disabled={runtimeState !== 'connected'}
        title={directory || 'Select repository'}
        ><span class="project-icon">⌁</span><span class="project-name"
          >{directory ? directory.split('/').filter(Boolean).at(-1) : 'Select repository'}</span
        ><span>⌄</span></button
      >
    </div>
    <div class="session-heading">
      <span class="label">PLAN SESSIONS</span><Button
        size="sm"
        variant="ghost"
        onclick={newPlan}
        disabled={!agentReady}
        aria-label="New plan">＋</Button
      >
    </div>
    {#if directory}<input
        class="session-search"
        aria-label="Search plan sessions"
        placeholder="Search plans"
        bind:value={sessionSearch}
        oninput={changeSearch}
      />{/if}
    <nav aria-label="Plan sessions">
      {#each visibleSessions as session (session.id)}<div
          class:active={session.id === sessionID}
          class="session-row"
        >
          {#if editingSessionID === session.id}<div class="session-edit">
              <input
                aria-label="Session title"
                bind:value={editedTitle}
                onkeydown={(event) => {
                  if (event.key === 'Enter') void saveRename();
                  if (event.key === 'Escape') editingSessionID = null;
                }}
              />
              <button aria-label="Save title" onclick={saveRename}>✓</button>
              <button aria-label="Cancel rename" onclick={() => (editingSessionID = null)}>×</button
              >
            </div>{:else}<button
              class="session-item"
              onclick={() => selectSession(session.id)}
              title={session.title ?? 'Untitled plan'}
              ><span class="session-symbol">◇</span><span class="session-details"
                ><strong>{session.title ?? 'Untitled plan'}</strong><small
                  >{session.agent ?? 'Unknown'} · {activeSessionIDs.includes(session.id)
                    ? 'Running'
                    : (session.outcome ?? 'Idle')}</small
                ><small>Updated {new Date(session.time.updated).toLocaleString()}</small></span
              ></button
            ><button
              class="session-action"
              aria-label={`Rename ${session.title ?? 'session'}`}
              onclick={() => startRename(session)}>✎</button
            ><button
              class="session-action"
              aria-label={`Delete ${session.title ?? 'session'}`}
              onclick={() => removeSession(session)}>×</button
            >{/if}
        </div>{:else}<p class="session-empty">
          {sessionLoading
            ? 'Loading plans…'
            : directory
              ? 'No plans found'
              : 'Choose a repository to begin'}
        </p>{/each}
    </nav>
    {#if directory && (previousSessionCursor || nextSessionCursor)}<div class="session-pages">
        <button
          disabled={!previousSessionCursor || sessionLoading}
          onclick={() => changePage(previousSessionCursor)}>Previous</button
        >
        <button
          disabled={!nextSessionCursor || sessionLoading}
          onclick={() => changePage(nextSessionCursor)}>Next</button
        >
      </div>{/if}
    <div class="sidebar-footer">
      <span class:connected={runtimeState === 'connected'} class="status-dot"></span><span
        >OpenCode {runtimeState}</span
      >
    </div>
  </aside>
  <div class="main-area">
    <header class="topbar">
      <div class="breadcrumb">
        <button
          class="breadcrumb-project"
          onclick={chooseProject}
          disabled={runtimeState !== 'connected'}
          >{directory ? directory.split('/').filter(Boolean).at(-1) : 'Workspace'} ⌄</button
        ><span class="slash">/</span><strong>{currentSession?.title ?? 'New plan'}</strong>
      </div>
      <div class="topbar-actions">
        {#if directory}<Button variant="ghost" size="sm" onclick={() => (setupOpen = !setupOpen)}
            >Repository setup</Button
          >{/if}
        <details class="runtime-settings" bind:open={runtimeSettingsOpen}>
          <summary>OpenCode settings</summary>
          <div class="runtime-settings-panel">
            {#if runtimeError}<p class="runtime-diagnostic" role="alert">{runtimeError}</p>{/if}
            {#if activeBinary}<p class="runtime-binary" title={activeBinary}>
                Detected: {activeBinary}
              </p>{/if}
            <label for="opencode-bin">Binary path</label>
            <input
              id="opencode-bin"
              type="text"
              bind:value={binaryPath}
              placeholder="Automatic detection"
            />
            <Button size="sm" onclick={retryRuntime}>Save and reconnect</Button>
          </div>
        </details>
        <Badge tone={agentReady ? 'success' : 'neutral'}
          >{agentReady ? 'Ready' : 'Setup needed'}</Badge
        ><Button variant="ghost" size="sm" onclick={() => setTheme(!dark)}
          >{dark ? 'Light' : 'Dark'} theme</Button
        >
      </div>
    </header>
    {#if setupOpen && (directory || setupError)}<section
        class="setup-panel"
        aria-label="Repository setup"
      >
        <div class="setup-heading">
          <div>
            <p class="eyebrow">REPOSITORY SETUP</p>
            <h2>{directory || 'Choose a repository'}</h2>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onclick={restartSetup}
            disabled={setupLoading || running || sending}
            >{setupLoading ? 'Checking…' : 'Restart and check'}</Button
          >
        </div>
        {#if setupError}<p class="notice error" role="alert">{setupError}</p>{/if}
        {#if setup && !setupError}<div class="setup-checks">
            {#each setupRows(setup) as [label, item] (label)}
              <div class="setup-check">
                <span class:ready={item.state === 'ready'} class="setup-indicator"
                  >{item.state === 'ready' ? '✓' : '!'}</span
                ><strong>{label}</strong><span>{item.detail}</span>
              </div>
            {/each}
          </div>{/if}
        {#if !agentReady}<div class="setup-steps">
            <strong>To start planning</strong>
            <p>
              Install OpenCode v2, then choose a Git repository. In OpenCode, run
              <code>/connect</code> to connect a provider and <code>/models</code> to select a model.
            </p>
            <p>
              Install the published plugin with <code
                >opencode plugin add @smykla-skalski/opencode-plugin-plan-review@latest</code
              >, or add a local checkout path to <code>opencode.jsonc</code>:
            </p>
            <pre>{'{ "plugins": ["/absolute/path/to/opencode-plugin-plan-review"] }'}</pre>
            <p>
              Choose <strong>Restart and check</strong> after changing plugin configuration. This app
              does not change your repository.
            </p>
          </div>{/if}
      </section>{/if}
    <div class="workspace">
      <main class="chat-area" aria-label="Architect conversation">
        <div class="conversation">
          {#if !sessionID && messages.length === 0}<div class="welcome">
              <div class="welcome-mark">◇</div>
              <p class="eyebrow">PLAN WITH ARCHITECT</p>
              <h1>What are we building?</h1>
              <p>
                Describe the work. The architect will explore the repository, ask for decisions, and
                create a plan you can review.
              </p>
              {#if !directory}<Button
                  onclick={chooseProject}
                  disabled={runtimeState !== 'connected'}>Select repository</Button
                >{/if}
            </div>{/if}
          {#each chatMessages as message (message.id)}
            {#if message.type === 'user'}<article class="message user-message">
                <div class="avatar user-avatar">You</div>
                <div class="message-body">
                  <div class="message-author">You</div>
                  <p>{message.text}</p>
                </div>
              </article>
            {:else if message.type === 'assistant'}<article class="message assistant-message">
                <div class="avatar agent-avatar">S.</div>
                <div class="message-body">
                  <div class="message-author">Architect</div>
                  {#if assistantText(message)}<p>
                      {assistantText(message)}
                    </p>{/if}{#if toolsUsed(message).length}<div class="tool-line">
                      Used {toolsUsed(message).join(', ')}
                    </div>{/if}{#if message.error}<div class="message-error">
                      {JSON.stringify(message.error)}
                    </div>{/if}
                </div>
              </article>{/if}
          {/each}
          {#if running}<div class="working">
              <span class="pulse"></span> Architect is working…
            </div>{/if}
          <div bind:this={chatEnd}></div>
        </div>
        <div class="composer-wrap">
          {#if error}<p class="notice error" role="alert">{error}</p>{/if}
          {#if pendingPermissions}<p class="notice" role="status">
              {pendingPermissions} permission request{pendingPermissions === 1 ? '' : 's'} waiting in
              OpenCode
            </p>{/if}
          <div class="composer">
            <textarea
              bind:value={draft}
              onkeydown={keydown}
              rows="3"
              placeholder={agentReady
                ? 'Describe a goal or ask the architect a question…'
                : 'Complete repository setup before planning…'}
              disabled={!agentReady || sending}></textarea>
            <div class="composer-bottom">
              <span>Enter to send · Shift+Enter for newline</span><Button
                onclick={send}
                disabled={!canSend}
                loading={sending}>Send ↗</Button
              >
            </div>
          </div>
        </div>
      </main>
      <PlanPanel
        {snapshot}
        client={connecting ? null : client}
        {directory}
        {dark}
        onchanged={() => refreshSession()}
      />
    </div>
  </div>
</div>
