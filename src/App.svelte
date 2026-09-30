<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-dialog';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { isSessionNotFoundError } from '@opencode/client';
  import type { FileDiffInfo, FormInfo, PermissionRequest } from '@opencode/client';
  import type { ModelRef } from '@opencode/client';
  import { Badge, Button } from '@smykla-skalski/sui';
  import Markdown from './Markdown.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import DiffPanel from './DiffPanel.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import PromptPanel from './PromptPanel.svelte';
  import {
    connect,
    type OpenCodeClient,
    type RuntimeInfo,
    type SessionInfo,
    type SessionMessageInfo,
  } from './lib/opencode';
  import { getHistory, getPlan, type HistoryEntry, type PlanSnapshot } from './lib/plan';
  import { mergeMessages, nearBottom } from './lib/timeline';
  import { fileUri } from './lib/attachments';
  import { annotateDiffs, repoPath, selectedDiffFile } from './lib/diff';
  import { inspectRepository, type SetupCheck, type SetupReport } from './lib/onboarding';

  let dark = $state(localStorage.getItem('sai-theme') === 'dark');
  let directory = $state(localStorage.getItem('sai-directory') ?? '');
  let binaryPath = $state(localStorage.getItem('sai-opencode-bin') ?? '');
  let appliedBinaryPath = localStorage.getItem('sai-opencode-bin') ?? '';
  let activeBinary = $state('');
  let runtimeSettingsOpen = $state(false);
  let runtimeState = $state<'starting' | 'connected' | 'error'>('starting');
  let runtimeError = $state('');
  let workReady = $state(false);
  let planReady = $state(false);
  let selectedAgentID = $state('');
  let selectedModelKey = $state('');
  let newSessionMode = $state<'work' | null>(null);
  let attachedFiles = $state<string[]>([]);
  let setup = $state<SetupReport | null>(null);
  let setupError = $state('');
  let setupLoading = $state(false);
  let setupOpen = $state(true);
  let sessions = $state<SessionInfo[]>([]);
  let selectedSession = $state<SessionInfo | null>(null);
  let sessionSearch = $state('');
  let sessionCursor = $state<string | undefined>(undefined);
  let nextSessionCursor = $state<string | null>(null);
  let sessionPageHistory = $state<(string | undefined)[]>([]);
  let sessionLoading = $state(false);
  let activeSessionIDs = $state<string[]>([]);
  let editingSessionID = $state<string | null>(null);
  let editedTitle = $state('');
  let sessionID = $state<string | null>(null);
  let messages = $state<SessionMessageInfo[]>([]);
  let olderMessageCursor = $state<string | null>(null);
  let loadingOlder = $state(false);
  let liveText = $state<Record<string, Record<number, string>>>({});
  let timelineSession = '';
  let timelineRefresh = 0;
  let followChat = true;
  let followFrame = 0;
  let messageTimers = new SvelteMap<
    string,
    { timer: ReturnType<typeof setTimeout>; settled: boolean }
  >();
  let messageGeneration = new SvelteMap<string, number>();
  let snapshot = $state<PlanSnapshot>({ plan: null, questions: null });
  let diffs = $state<FileDiffInfo[]>([]);
  let diffLoading = $state(false);
  let diffError = $state('');
  let historyEvents = $state<HistoryEntry[]>([]);
  let historyLoading = $state(false);
  let historyError = $state('');
  let selectedFilePath = $state<string | null>(null);
  let sideTab = $state<'plan' | 'changes' | 'history'>('plan');
  let diffRefresh = 0;
  let historyRefresh = 0;
  let draft = $state('');
  let sending = $state(false);
  let switching = $state(false);
  let running = $state(false);
  let error = $state('');
  let chatScroll: HTMLDivElement;
  let client = $state<OpenCodeClient | null>(null);
  let eventController: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let connecting = $state(false);
  let disposed = false;
  let hasConnected = false;
  let pendingPermissions = $state<PermissionRequest[]>([]);
  let pendingForms = $state<FormInfo[]>([]);
  let selection = 0;
  let sessionRefresh = 0;
  let promptRefresh = 0;

  let currentSession = $derived(
    sessions.find((session) => session.id === sessionID) ??
      (selectedSession?.id === sessionID ? selectedSession : undefined),
  );
  let visibleSessions = $derived(
    !sessionSearch.trim() &&
      selectedSession &&
      !sessions.some((session) => session.id === selectedSession?.id)
      ? [selectedSession, ...sessions]
      : sessions,
  );
  let chatMessages = $derived(
    messages.filter((message) => message.type === 'user' || message.type === 'assistant'),
  );
  let liveOnly = $derived(
    Object.entries(liveText).filter(([id]) => !messages.some((message) => message.id === id)),
  );
  let canSend = $derived(
    runtimeState === 'connected' &&
      !connecting &&
      !!client &&
      !!directory &&
      (workReady || (currentSession?.agent === 'architect' && planReady)) &&
      (!!draft.trim() || attachedFiles.length > 0) &&
      !sending &&
      !switching,
  );
  let inputReady = $derived(workReady || (currentSession?.agent === 'architect' && planReady));

  function modelKey(model: ModelRef) {
    return `${model.providerID}:${model.id}`;
  }

  let chosenModel = $derived(setup?.models.find((model) => modelKey(model) === selectedModelKey));
  let showPlanPanel = $derived(!!snapshot.plan || !!snapshot.questions);
  let activeSideTab = $derived(
    showPlanPanel && sideTab === 'plan' ? 'plan' : sideTab === 'history' ? 'history' : 'changes',
  );
  let diffAnnotations = $derived(annotateDiffs(diffs, snapshot.plan, directory));

  function setupRows(report: SetupReport): [string, SetupCheck][] {
    return [
      ['OpenCode location', report.location],
      ['Plan-review plugin', report.plugin],
      ['Architect agent', report.architect],
      ['Plan RPC', report.rpc],
      ['Provider and model', report.model],
      ['Architect model', report.planModel],
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
      cancelAnimationFrame(followFrame);
      for (const pending of messageTimers.values()) clearTimeout(pending.timer);
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
    liveText = {};
    const current = selection;
    await refreshSetup(directory);
    if (current !== selection) return;
    if (!workReady && !planReady) return;
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
    const active = await client.session.active();
    if (path !== directory) return;
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
    workReady = false;
    planReady = false;
    setup = null;
    selectedAgentID = '';
    selectedModelKey = '';
    attachedFiles = [];
    setupOpen = true;
    sessionID = null;
    selectedSession = null;
    sessions = [];
    activeSessionIDs = [];
    sessionSearch = '';
    sessionCursor = undefined;
    nextSessionCursor = null;
    sessionPageHistory = [];
    resetTimeline();
    running = false;
    pendingPermissions = [];
    pendingForms = [];
    snapshot = { plan: null, questions: null };
    diffs = [];
    selectedFilePath = null;
    diffError = '';
    ++diffRefresh;
    diffLoading = false;
    historyEvents = [];
    historyError = '';
    ++historyRefresh;
    historyLoading = false;
    if (!(await refreshSetup(path)) || current !== selection) return;
    if (!workReady && !planReady) return;
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
      workReady = report.workReady;
      planReady = report.planReady;
      if (!selectedAgentID || !report.agents.some((agent) => agent.id === selectedAgentID))
        selectedAgentID =
          report.agents.find((agent) => agent.id !== 'architect')?.id ?? report.agents[0]?.id ?? '';
      if (!selectedModelKey || !report.models.some((model) => modelKey(model) === selectedModelKey))
        selectedModelKey = report.defaultModel ? modelKey(report.defaultModel) : '';
      setupOpen = !report.workReady;
      return true;
    } catch (cause) {
      if (current !== selection) return false;
      setupError = describe(cause);
      setupOpen = true;
      workReady = false;
      planReady = false;
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
    const source = client;
    const path = directory;
    const search = sessionSearch.trim();
    const cursor = sessionCursor;
    const current = ++sessionRefresh;
    sessionLoading = true;
    try {
      async function collect(
        pageCursor: string | undefined,
        matches: SessionInfo[],
        seen: Set<string>,
      ): Promise<{ matches: SessionInfo[]; next: string | null }> {
        const result = await source.session.list({
          directory: path,
          limit: 25,
          order: 'desc',
          parentID: null,
          ...(search ? { search } : {}),
          ...(pageCursor ? { cursor: pageCursor } : {}),
        });
        matches.push(...result.data);
        const following = result.cursor.next ?? null;
        if (
          matches.length >= 25 ||
          !following ||
          following === pageCursor ||
          seen.has(following) ||
          path !== directory ||
          current !== sessionRefresh ||
          search !== sessionSearch.trim() ||
          cursor !== sessionCursor
        ) {
          return { matches, next: following };
        }
        seen.add(following);
        return collect(following, matches, seen);
      }
      const { matches, next } = await collect(cursor, [], new Set());
      if (
        path !== directory ||
        current !== sessionRefresh ||
        search !== sessionSearch.trim() ||
        cursor !== sessionCursor
      )
        return;
      const active = await source.session.active();
      if (path !== directory || current !== sessionRefresh) return;
      sessions = matches;
      nextSessionCursor = next;
      activeSessionIDs = Object.keys(active);
      running = !!sessionID && activeSessionIDs.includes(sessionID);
      const selected = sessions.find((session) => session.id === sessionID);
      if (selected) {
        selectedSession = selected;
        syncSessionChoice(selected);
      } else if (sessionID) {
        const requestedID = sessionID;
        try {
          const info = await client.session.get({ sessionID: requestedID });
          if (path === directory && current === sessionRefresh && requestedID === sessionID) {
            selectedSession = info;
            syncSessionChoice(info);
          }
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
      selectedSession = info;
      syncSessionChoice(info);
      await selectSession(id);
      return true;
    } catch (cause) {
      if (isSessionNotFoundError(cause)) return false;
      throw cause;
    }
  }

  function clearSelectedSession() {
    sessionID = null;
    selectedSession = null;
    resetTimeline();
    snapshot = { plan: null, questions: null };
    attachedFiles = [];
    running = false;
    pendingPermissions = [];
    pendingForms = [];
    localStorage.removeItem(`sai-session:${directory}`);
  }

  async function selectSession(id: string) {
    const current = ++selection;
    sessionID = id;
    selectedSession = sessions.find((session) => session.id === id) ?? selectedSession;
    if (selectedSession?.id === id) syncSessionChoice(selectedSession);
    newSessionMode = null;
    attachedFiles = [];
    resetTimeline();
    running = activeSessionIDs.includes(id);
    pendingPermissions = [];
    pendingForms = [];
    snapshot = { plan: null, questions: null };
    diffs = [];
    selectedFilePath = null;
    diffError = '';
    ++diffRefresh;
    diffLoading = false;
    historyEvents = [];
    historyError = '';
    ++historyRefresh;
    historyLoading = false;
    sideTab = 'plan';
    error = '';
    localStorage.setItem(`sai-session:${directory}`, id);
    await refreshSession(id, current);
  }

  function syncSessionChoice(session: SessionInfo) {
    if (session.agent) selectedAgentID = session.agent;
    if (session.model) selectedModelKey = modelKey(session.model);
  }

  function newWork() {
    if (!workReady || switching || sending) return;
    ++selection;
    sessionID = null;
    selectedSession = null;
    newSessionMode = 'work';
    selectedAgentID =
      setup?.agents.find((agent) => agent.id !== 'architect')?.id ?? selectedAgentID;
    if (setup?.defaultModel) selectedModelKey = modelKey(setup.defaultModel);
    resetTimeline();
    snapshot = { plan: null, questions: null };
    diffs = [];
    selectedFilePath = null;
    sideTab = 'changes';
    ++diffRefresh;
    diffLoading = false;
    historyEvents = [];
    historyError = '';
    ++historyRefresh;
    historyLoading = false;
    pendingPermissions = [];
    pendingForms = [];
    attachedFiles = [];
    running = false;
    draft = '';
    error = '';
  }

  async function newPlan() {
    if (!client || !directory || !planReady || switching || sending) return;
    const path = directory;
    const current = selection;
    try {
      const session = await client.session.create({
        agent: 'architect',
        location: { directory: path },
        metadata: { saiHarness: true },
        title: 'New plan',
      });
      if (current !== selection || path !== directory) return;
      sessionSearch = '';
      sessionCursor = undefined;
      sessionPageHistory = [];
      await refreshSessions();
      if (current !== selection || path !== directory) return;
      selectedSession = session;
      await selectSession(session.id);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function chooseAgent(id: string) {
    if (switching) return;
    const previous = selectedAgentID;
    selectedAgentID = id;
    if (!client || !sessionID) return;
    const current = sessionID;
    switching = true;
    try {
      await client.session.switchAgent({ sessionID: current, agent: id });
      const info = await client.session.get({ sessionID: current });
      if (current === sessionID) {
        selectedSession = info;
        syncSessionChoice(info);
      }
      await refreshSessions();
    } catch (cause) {
      if (current === sessionID) selectedAgentID = previous;
      error = describe(cause);
    } finally {
      switching = false;
    }
  }

  async function chooseModel(key: string) {
    if (switching) return;
    const previous = selectedModelKey;
    selectedModelKey = key;
    if (!client || !sessionID) return;
    const model = setup?.models.find((item) => modelKey(item) === key);
    if (!model) return;
    const current = sessionID;
    switching = true;
    try {
      await client.session.switchModel({
        sessionID: current,
        model: { id: model.id, providerID: model.providerID },
      });
      const info = await client.session.get({ sessionID: current });
      if (current === sessionID) {
        selectedSession = info;
        syncSessionChoice(info);
      }
      await refreshSessions();
    } catch (cause) {
      if (current === sessionID) selectedModelKey = previous;
      error = describe(cause);
    } finally {
      switching = false;
    }
  }

  async function attachFiles() {
    const current = selection;
    const originalSessionID = sessionID;
    const path = directory;
    const e2ePath =
      import.meta.env.MODE === 'e2e' ? sessionStorage.getItem('sai-e2e-attachment-path') : null;
    if (e2ePath) sessionStorage.removeItem('sai-e2e-attachment-path');
    const selected =
      e2ePath ?? (await open({ multiple: true, directory: false, title: 'Attach files' }));
    if (current !== selection || originalSessionID !== sessionID || path !== directory) return;
    const paths = typeof selected === 'string' ? [selected] : (selected ?? []);
    attachedFiles = [...new Set([...attachedFiles, ...paths])];
  }

  function changeSearch() {
    sessionCursor = undefined;
    sessionPageHistory = [];
    void refreshSessions().catch((cause) => {
      error = describe(cause);
    });
  }

  function nextPage() {
    if (!nextSessionCursor) return;
    sessionPageHistory = [...sessionPageHistory, sessionCursor];
    sessionCursor = nextSessionCursor;
    void refreshSessions().catch((cause) => {
      error = describe(cause);
    });
  }

  function previousPage() {
    if (!sessionPageHistory.length) return;
    sessionCursor = sessionPageHistory[sessionPageHistory.length - 1];
    sessionPageHistory = sessionPageHistory.slice(0, -1);
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
    const e2eAnswer =
      import.meta.env.MODE === 'e2e' ? sessionStorage.getItem('sai-e2e-delete-answer') : null;
    if (e2eAnswer) sessionStorage.removeItem('sai-e2e-delete-answer');
    const confirmed =
      e2eAnswer === 'Yes'
        ? true
        : e2eAnswer === 'No'
          ? false
          : await ask(`Delete “${session.title ?? 'Untitled plan'}”? This cannot be undone.`, {
              title: 'Delete plan session',
              kind: 'warning',
            });
    if (!confirmed) return;
    try {
      await client.session.remove({ sessionID: session.id });
      if (session.id === sessionID) clearSelectedSession();
      await refreshSessions();
      if (!sessions.length && sessionPageHistory.length) previousPage();
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function refreshPrompts(id = sessionID, current = selection) {
    if (!client || !id || !directory) return;
    const source = client;
    const request = ++promptRefresh;
    const valid = () => current === selection && id === sessionID && request === promptRefresh;
    const permissionsTask = (async () => {
      try {
        const requests = await source.permission.list({ sessionID: id });
        if (valid()) pendingPermissions = requests;
      } catch (cause) {
        if (valid()) error = describe(cause);
      }
    })();
    const formsTask = (async () => {
      try {
        const forms = await source.session.form.list({ sessionID: id });
        if (valid()) pendingForms = forms;
      } catch (cause) {
        if (valid()) error = describe(cause);
      }
    })();
    await Promise.all([permissionsTask, formsTask]);
  }

  function resetTimeline() {
    ++timelineRefresh;
    timelineSession = '';
    messages = [];
    olderMessageCursor = null;
    loadingOlder = false;
    liveText = {};
    followChat = true;
    for (const pending of messageTimers.values()) clearTimeout(pending.timer);
    messageTimers.clear();
    messageGeneration.clear();
  }

  function scrollToLatest() {
    if (!followChat) return;
    cancelAnimationFrame(followFrame);
    followFrame = requestAnimationFrame(() => {
      if (chatScroll && followChat) chatScroll.scrollTop = chatScroll.scrollHeight;
    });
  }

  function acceptProjectedMessages(
    incoming: SessionMessageInfo[],
    observed: Record<string, number>,
  ): SessionMessageInfo[] {
    const accepted = incoming.filter(
      (message) => (messageGeneration.get(message.id) ?? 0) === (observed[message.id] ?? 0),
    );
    for (const message of accepted)
      messageGeneration.set(message.id, (messageGeneration.get(message.id) ?? 0) + 1);
    return accepted;
  }

  async function refreshTimeline(id: string, current: number) {
    if (!client) return;
    const source = client;
    const request = ++timelineRefresh;
    const observed = Object.fromEntries(messageGeneration);
    const valid = () => current === selection && id === sessionID && request === timelineRefresh;
    const first = await source.message.list({ sessionID: id, limit: 50, order: 'desc' });
    if (!valid()) return;
    if (timelineSession !== id) {
      timelineSession = id;
      messages = acceptProjectedMessages(first.data, observed).toReversed();
      olderMessageCursor = first.cursor.next ?? null;
      await tick();
      scrollToLatest();
      return;
    }
    const known = new Set(messages.map((message) => message.id));
    async function collectGap(
      cursor: string | null,
      incoming: SessionMessageInfo[],
    ): Promise<SessionMessageInfo[]> {
      if (!cursor || !incoming.length || incoming.some((message) => known.has(message.id)))
        return incoming;
      const page = await source.message.list({ sessionID: id, limit: 50, cursor });
      if (!valid()) return incoming;
      const combined = [...incoming, ...page.data];
      if (page.cursor.next === cursor || !page.data.length) return combined;
      return collectGap(page.cursor.next ?? null, combined);
    }
    const incoming = await collectGap(first.cursor.next ?? null, [...first.data]);
    if (!valid()) return;
    messages = mergeMessages(messages, acceptProjectedMessages(incoming, observed));
    await tick();
    scrollToLatest();
  }

  async function loadOlderMessages() {
    if (!client || !sessionID || !olderMessageCursor || loadingOlder) return;
    const id = sessionID;
    const current = selection;
    const cursor = olderMessageCursor;
    const observed = Object.fromEntries(messageGeneration);
    const height = chatScroll?.scrollHeight ?? 0;
    const top = chatScroll?.scrollTop ?? 0;
    loadingOlder = true;
    try {
      const page = await client.message.list({ sessionID: id, limit: 50, cursor });
      if (current !== selection || id !== sessionID) return;
      messages = mergeMessages(messages, acceptProjectedMessages(page.data, observed));
      olderMessageCursor = page.cursor.next ?? null;
      followChat = false;
      await tick();
      if (chatScroll) chatScroll.scrollTop = top + chatScroll.scrollHeight - height;
    } catch (cause) {
      error = describe(cause);
    } finally {
      loadingOlder = false;
    }
  }

  async function refreshMessage(
    id: string,
    messageID: string,
    settled: boolean,
    generation: number,
  ) {
    if (!client) return;
    const current = selection;
    try {
      const message = await client.session.message.get({ sessionID: id, messageID });
      if (
        current !== selection ||
        id !== sessionID ||
        messageGeneration.get(messageID) !== generation
      )
        return;
      messages = mergeMessages(messages, [message]);
      if (settled) {
        const remaining = { ...liveText };
        delete remaining[messageID];
        liveText = remaining;
      }
      await tick();
      scrollToLatest();
    } catch {
      // The projection may not exist yet; the next durable event or resync will load it.
    }
  }

  function scheduleMessageRefresh(id: string, messageID: string, settled = false) {
    const previous = messageTimers.get(messageID);
    if (previous) clearTimeout(previous.timer);
    const generation = (messageGeneration.get(messageID) ?? 0) + 1;
    messageGeneration.set(messageID, generation);
    const timer = setTimeout(() => {
      messageTimers.delete(messageID);
      void refreshMessage(id, messageID, settled || !!previous?.settled, generation);
    }, 80);
    messageTimers.set(messageID, { timer, settled: settled || !!previous?.settled });
  }

  async function refreshDiff(id = sessionID, current = selection) {
    if (!client || !id || !directory) return;
    const source = client;
    const path = directory;
    const generation = ++diffRefresh;
    diffLoading = true;
    try {
      const next = await source.session.diff({ sessionID: id });
      if (
        generation !== diffRefresh ||
        current !== selection ||
        id !== sessionID ||
        path !== directory
      )
        return;
      diffs = next;
      diffError = '';
      selectedFilePath = selectedDiffFile(next, selectedFilePath, path);
    } catch (cause) {
      if (generation === diffRefresh && current === selection && id === sessionID)
        diffError = describe(cause);
    } finally {
      if (generation === diffRefresh) diffLoading = false;
    }
  }

  async function refreshHistory(id = sessionID, current = selection) {
    if (!client || !id || !directory) return;
    if (setup?.rpc.state !== 'ready') {
      historyEvents = [];
      historyError = 'Install the plan-review plugin to record plan history.';
      return;
    }
    const source = client;
    const path = directory;
    const generation = ++historyRefresh;
    historyLoading = true;
    try {
      const next = await getHistory(source, path, id);
      if (
        generation !== historyRefresh ||
        current !== selection ||
        id !== sessionID ||
        path !== directory
      )
        return;
      historyEvents = next;
      historyError = '';
    } catch (cause) {
      if (generation === historyRefresh && current === selection && id === sessionID) {
        historyError = describe(cause);
        historyEvents = [];
      }
    } finally {
      if (generation === historyRefresh) historyLoading = false;
    }
  }

  function selectDiffPath(path: string) {
    sideTab = 'changes';
    const key = repoPath(path, directory);
    selectedFilePath =
      (key ? diffs.find((file) => repoPath(file.file, directory) === key)?.file : undefined) ??
      path;
  }

  async function refreshSession(id = sessionID, current = selection) {
    if (!client || !id || !directory) return;
    const source = client;
    const path = directory;
    const [history, plan] = await Promise.allSettled([
      refreshTimeline(id, current),
      setup?.rpc.state === 'ready'
        ? getPlan(source, path, id)
        : Promise.resolve({ plan: null, questions: null } as PlanSnapshot),
      refreshPrompts(id, current),
      refreshDiff(id, current),
      refreshHistory(id, current),
    ]);
    if (current !== selection || id !== sessionID) return;
    if (history.status === 'rejected') error = describe(history.reason);
    if (plan.status === 'fulfilled') snapshot = plan.value;
    else error = describe(plan.reason);
  }

  async function refreshSidePanels() {
    if (!client || !sessionID || !directory) return;
    const source = client;
    const id = sessionID;
    const path = directory;
    const current = selection;
    const [plan] = await Promise.allSettled([
      setup?.rpc.state === 'ready'
        ? getPlan(source, path, id)
        : Promise.resolve({ plan: null, questions: null } as PlanSnapshot),
      refreshPrompts(id, current),
      refreshDiff(id, current),
      refreshHistory(id, current),
    ]);
    if (current !== selection || id !== sessionID) return;
    if (plan.status === 'fulfilled') snapshot = plan.value;
    else error = describe(plan.reason);
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshSidePanels(), 120);
  }

  function applyTextDelta(messageID: string, ordinal: number, delta: string) {
    const existing = messages.find((message) => message.id === messageID);
    const part = existing?.type === 'assistant' ? existing.content[ordinal] : undefined;
    const parts = liveText[messageID] ?? {};
    const base = parts[ordinal] ?? (part?.type === 'text' ? part.text : '');
    liveText[messageID] = { ...parts, [ordinal]: base + delta };
    scrollToLatest();
  }

  async function reconcileExecution(id: string, current: number) {
    await refreshTimeline(id, current);
    if (id === sessionID && !running) liveText = {};
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
          const eventType: string = event.type;
          if (
            eventType === 'session.message.content.updated' &&
            'data' in event &&
            'messageID' in event.data &&
            typeof event.data.messageID === 'string' &&
            sessionID
          )
            scheduleMessageRefresh(sessionID, event.data.messageID);
          if (event.type === 'session.text.delta') {
            applyTextDelta(event.data.assistantMessageID, event.data.ordinal, event.data.delta);
            continue;
          }
          if (event.type === 'session.text.ended') {
            const parts = liveText[event.data.assistantMessageID] ?? {};
            liveText[event.data.assistantMessageID] = {
              ...parts,
              [event.data.ordinal]: event.data.text,
            };
            scheduleMessageRefresh(event.data.sessionID, event.data.assistantMessageID, true);
          }
          if (
            'data' in event &&
            'assistantMessageID' in event.data &&
            typeof event.data.assistantMessageID === 'string' &&
            event.type !== 'session.text.ended'
          )
            scheduleMessageRefresh(event.data.sessionID, event.data.assistantMessageID);
          if (event.type === 'session.execution.started') running = true;
          if (
            [
              'session.execution.succeeded',
              'session.execution.failed',
              'session.execution.interrupted',
            ].includes(event.type)
          )
            running = false;
          if (
            [
              'session.execution.started',
              'session.execution.succeeded',
              'session.execution.failed',
              'session.execution.interrupted',
            ].includes(event.type) &&
            sessionID
          )
            void reconcileExecution(sessionID, selection).catch((cause) => {
              error = describe(cause);
            });
          if (
            event.type === 'rpc.planreview.changed' ||
            [
              'session.execution.succeeded',
              'session.execution.failed',
              'session.execution.interrupted',
            ].includes(event.type)
          )
            scheduleRefresh();
        }
        if (
          event.type === 'permission.asked' ||
          event.type === 'permission.replied' ||
          event.type === 'form.created' ||
          event.type === 'form.replied' ||
          event.type === 'form.cancelled'
        )
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
    let current = selection;
    const path = directory;
    const text = draft.trim();
    const files = [...attachedFiles];
    draft = '';
    attachedFiles = [];
    sending = true;
    error = '';
    try {
      let id = sessionID;
      if (!id) {
        const session = await client.session.create({
          agent: selectedAgentID || undefined,
          model: chosenModel
            ? { id: chosenModel.id, providerID: chosenModel.providerID }
            : undefined,
          location: { directory: path },
          metadata: { saiHarness: true },
          title: text ? (text.length > 60 ? `${text.slice(0, 57)}…` : text) : 'New work',
        });
        id = session.id;
        if (current === selection && path === directory) {
          await refreshSessions();
          if (current === selection && path === directory) {
            selectedSession = session;
            await selectSession(id);
            if (sessionID === id && path === directory) current = selection;
          }
        }
      } else if (
        text &&
        (currentSession?.title === 'New plan' || currentSession?.title === 'New work')
      ) {
        await client.session.update({
          sessionID: id,
          title: text.length > 60 ? `${text.slice(0, 57)}…` : text,
        });
        if (current === selection && path === directory) await refreshSessions();
      }
      if (current === selection && path === directory) running = true;
      await client.session.prompt({
        sessionID: id,
        text,
        files: files.map((filePath) => ({
          uri: fileUri(filePath),
          name: filePath.split(/[\\/]/).at(-1),
        })),
      });
      if (current === selection && path === directory) await refreshSession(id);
    } catch (cause) {
      if (current === selection && path === directory) {
        draft = text;
        attachedFiles = files;
        running = false;
        error = describe(cause);
      }
    } finally {
      sending = false;
    }
  }

  async function stop() {
    if (!client || !sessionID || !running) return;
    const id = sessionID;
    try {
      await client.session.interrupt({ sessionID: id });
      if (id === sessionID) running = false;
      await refreshTimeline(id, selection);
    } catch (cause) {
      error = `Could not stop the agent: ${describe(cause)}`;
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
          .map((part, ordinal) =>
            part.type === 'text' ? (liveText[message.id]?.[ordinal] ?? part.text) : '',
          )
          .filter(Boolean)
          .join('\n')
      : '';
  }
</script>

<svelte:head><title>SAI Harness · Plan workspace</title></svelte:head>
<div class="app-shell">
  <aside class="sidebar" aria-label="Sessions">
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
      <span class="label">SESSIONS</span><Button
        size="sm"
        variant="ghost"
        onclick={newWork}
        disabled={!workReady || switching || sending}
        aria-label="New work">New work</Button
      >
      <Button
        size="sm"
        variant="ghost"
        onclick={newPlan}
        disabled={!planReady || switching || sending}
        title={planReady
          ? 'Start an Architect plan'
          : 'Complete Architect setup in Repository setup'}
        aria-label="New plan">New plan</Button
      >
    </div>
    {#if directory}<input
        class="session-search"
        aria-label="Search sessions"
        placeholder="Search sessions"
        bind:value={sessionSearch}
        oninput={changeSearch}
      />{/if}
    <nav aria-label="Sessions">
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
              title={session.title ?? 'Untitled session'}
              ><span class="session-symbol">◇</span><span class="session-details"
                ><strong>{session.title ?? 'Untitled session'}</strong><small
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
            ? 'Loading sessions…'
            : directory
              ? 'No sessions found'
              : 'Choose a repository to begin'}
        </p>{/each}
    </nav>
    {#if directory && (sessionPageHistory.length || nextSessionCursor)}<div class="session-pages">
        <button disabled={!sessionPageHistory.length || sessionLoading} onclick={previousPage}
          >Previous</button
        >
        <button disabled={!nextSessionCursor || sessionLoading} onclick={nextPage}>Next</button>
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
        ><span class="slash">/</span><strong
          >{currentSession?.title ??
            (newSessionMode === 'work' ? 'New work' : 'New session')}</strong
        >
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
        <Badge tone={workReady ? 'success' : 'neutral'}
          >{workReady ? 'Ready' : 'Setup needed'}</Badge
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
        {#if !planReady}<div class="setup-steps">
            <strong>To start planning</strong>
            {#if workReady}<p>
                General agent work is ready. Planning needs the Architect and plan-review plugin.
              </p>{/if}
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
    <div class:single={!sessionID} class="workspace">
      <main class="chat-area" aria-label="Session conversation">
        <div
          class="conversation"
          bind:this={chatScroll}
          onscroll={() => (followChat = nearBottom(chatScroll))}
        >
          {#if olderMessageCursor}<button
              class="older-messages"
              onclick={loadOlderMessages}
              disabled={loadingOlder}
            >
              {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
            </button>{/if}
          {#if !sessionID && messages.length === 0}<div class="welcome">
              <div class="welcome-mark">◇</div>
              <p class="eyebrow">PLAN WITH ARCHITECT</p>
              <h1>What are we working on?</h1>
              <p>
                Choose an agent and model, then describe the work. Use New plan for Architect-first
                planning.
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
                  <Markdown source={message.text} />
                  {#if message.files?.length}<div class="message-files">
                      {#each message.files as file, fileIndex (fileIndex)}<span
                          >{file.name ??
                            (file.source.type === 'uri' ? file.source.uri : 'Attachment')}</span
                        >{/each}
                    </div>{/if}
                </div>
              </article>
            {:else if message.type === 'assistant'}<article class="message assistant-message">
                <div class="avatar agent-avatar">S.</div>
                <div class="message-body">
                  <div class="message-author">{message.agent}</div>
                  {#if assistantText(message)}<Markdown source={assistantText(message)} />{/if}
                  {#each message.content as part, ordinal (ordinal)}
                    {#if part.type === 'tool'}<details class="tool-card">
                        <summary>{part.name} · {part.state.status}</summary>
                        {#if part.state.status === 'streaming'}<pre>{part.state.input}</pre>
                        {:else}<pre>{JSON.stringify(part.state.input, null, 2)}</pre>{/if}
                        {#if part.state.status === 'completed' || part.state.status === 'error'}
                          {#each part.state.content ?? [] as item, itemIndex (itemIndex)}
                            {#if item.type === 'text'}<pre>{item.text}</pre>
                            {:else}<p>{item.name ?? item.uri}</p>{/if}
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
              </article>{/if}
          {/each}
          {#each liveOnly as [id, parts] (id)}
            <article class="message assistant-message" data-message-id={id}>
              <div class="avatar agent-avatar">S.</div>
              <div class="message-body">
                <div class="message-author">{currentSession?.agent ?? 'Agent'} · streaming</div>
                <Markdown
                  source={Object.entries(parts)
                    .toSorted(([a], [b]) => Number(a) - Number(b))
                    .map(([, value]) => value)
                    .join('\n')}
                />
              </div>
            </article>
          {/each}
          {#if running}<div class="working">
              <span class="pulse"></span>
              {currentSession?.agent ?? 'Agent'} is working…
              <Button size="sm" variant="secondary" onclick={stop}>Stop</Button>
            </div>{/if}
        </div>
        <div class="composer-wrap">
          {#if error}<p class="notice error" role="alert">{error}</p>{/if}
          <PromptPanel
            {pendingPermissions}
            {pendingForms}
            client={connecting ? null : client}
            {sessionID}
            onchanged={() => refreshPrompts()}
          />
          <div class="composer">
            <div class="work-controls">
              <label
                >Agent<select
                  value={selectedAgentID}
                  disabled={running || sending || switching || !workReady}
                  onchange={(event) => void chooseAgent(event.currentTarget.value)}
                >
                  {#each setup?.agents ?? [] as agent (agent.id)}<option value={agent.id}
                      >{agent.name}</option
                    >{/each}
                </select></label
              >
              <label
                >Model<select
                  value={selectedModelKey}
                  disabled={running || sending || switching || !workReady}
                  onchange={(event) => void chooseModel(event.currentTarget.value)}
                >
                  {#each setup?.models ?? [] as model (modelKey(model))}<option
                      value={modelKey(model)}>{model.providerID} / {model.name}</option
                    >{/each}
                </select></label
              >
            </div>
            {#if attachedFiles.length}<div class="attachments">
                {#each attachedFiles as path (path)}<span
                    >{path.split(/[\\/]/).at(-1)}<button
                      aria-label={`Remove ${path.split(/[\\/]/).at(-1)}`}
                      onclick={() =>
                        (attachedFiles = attachedFiles.filter((item) => item !== path))}>×</button
                    ></span
                  >{/each}
              </div>{/if}
            <textarea
              bind:value={draft}
              onkeydown={keydown}
              rows="3"
              placeholder={inputReady
                ? 'Describe the work or ask a question…'
                : 'Complete repository setup before planning…'}
              disabled={!inputReady || sending}></textarea>
            <div class="composer-bottom">
              <span>Enter to send · Shift+Enter for newline</span><Button
                variant="ghost"
                size="sm"
                onclick={attachFiles}
                disabled={!inputReady || sending}>Attach files</Button
              ><Button onclick={send} disabled={!canSend} loading={sending}>Send ↗</Button>
            </div>
          </div>
        </div>
      </main>
      {#if sessionID}<section class="side-area" aria-label="Session details">
          <nav class="side-tabs" aria-label="Session detail tabs">
            {#if showPlanPanel}<button
                class:active={activeSideTab === 'plan'}
                aria-current={activeSideTab === 'plan' ? 'page' : undefined}
                onclick={() => (sideTab = 'plan')}>Plan</button
              >{/if}<button
              class:active={activeSideTab === 'changes'}
              aria-current={activeSideTab === 'changes' ? 'page' : undefined}
              onclick={() => (sideTab = 'changes')}>Changes ({diffs.length})</button
            ><button
              class:active={activeSideTab === 'history'}
              aria-current={activeSideTab === 'history' ? 'page' : undefined}
              onclick={() => (sideTab = 'history')}>History</button
            >
          </nav>
          <div class="side-panel-body">
            {#if showPlanPanel}<div class:inactive={activeSideTab !== 'plan'} class="side-view">
                <PlanPanel
                  {snapshot}
                  client={connecting ? null : client}
                  {directory}
                  {sessionID}
                  {dark}
                  onchanged={() => refreshSession()}
                  onselectfile={selectDiffPath}
                />
              </div>{/if}
            <div class:inactive={activeSideTab !== 'changes'} class="side-view">
              <DiffPanel
                files={diffs}
                annotations={diffAnnotations}
                selected={selectedFilePath}
                loading={diffLoading}
                error={diffError}
                onselect={(file) => (selectedFilePath = file)}
                onrefresh={() => refreshDiff()}
              />
            </div>
            <div class:inactive={activeSideTab !== 'history'} class="side-view">
              <HistoryPanel
                events={historyEvents}
                session={currentSession}
                loading={historyLoading}
                error={historyError}
                onrefresh={() => refreshHistory()}
              />
            </div>
          </div>
        </section>{/if}
    </div>
  </div>
</div>
