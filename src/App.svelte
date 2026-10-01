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
  import ProjectSidebar from './ProjectSidebar.svelte';
  import AgentWorkspace from './AgentWorkspace.svelte';
  import {
    acp,
    loadAgentThreads,
    saveAgentThreads,
    type AgentAvailability,
    type AgentId,
    type AgentThread,
  } from './lib/acp';
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
  import {
    addWorktree,
    assignRepository,
    loadProjectCatalog,
    removeRepository,
    replaceRepositoryPath,
    type ProjectCatalog,
  } from './lib/projects';

  let dark = $state(localStorage.getItem('sai-theme') === 'dark');
  const savedAgentThreads = loadAgentThreads();
  const savedDirectory =
    localStorage.getItem('sai-directory') ?? savedAgentThreads[0]?.directory ?? '';
  let directory = $state(savedDirectory);
  let projectCatalog = $state<ProjectCatalog>(
    loadProjectCatalog(localStorage.getItem('sai-project-catalog'), savedDirectory),
  );
  let binaryPath = $state(localStorage.getItem('sai-opencode-bin') ?? '');
  let appliedBinaryPath = localStorage.getItem('sai-opencode-bin') ?? '';
  let activeBinary = $state('');
  let runtimeSettingsOpen = $state(false);
  let agentAvailability = $state<AgentAvailability[]>([]);
  let agentThreads = $state<AgentThread[]>(savedAgentThreads);
  let agentChangesOpen = $state(false);
  let acpAgent = $state<AgentId | null>(null);
  let acpThread = $state<AgentThread | null>(null);
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
  type SideTab = 'plan' | 'changes' | 'history';
  let sideTab = $state<SideTab>('plan');
  let detailsOpen = $state(true);
  let diffRefresh = 0;
  let historyRefresh = 0;
  let draft = $state('');
  let mobileView = $state<'sessions' | 'chat' | 'details'>('chat');
  const viewStates = new SvelteMap<
    string,
    {
      draft: string;
      scrollTop: number;
      follow: boolean;
      messageCount: number;
      anchorID: string | null;
      anchorOffset: number;
      sideTab: SideTab;
      selectedFilePath: string | null;
      sideScroll: Partial<Record<SideTab, number[]>>;
    }
  >();
  let sending = $state(false);
  let switching = $state(false);
  let running = $state(false);
  let activity = $state('Thinking');
  let activityTool = '';
  const savedDetailsWidth = Number(localStorage.getItem('sai-details-width'));
  let detailsWidth = $state(
    Number.isFinite(savedDetailsWidth) && savedDetailsWidth >= 320 ? savedDetailsWidth : 420,
  );
  let workspaceWidth = $state(0);
  let workspaceElement: HTMLDivElement;
  let resizeStart: { x: number; width: number } | null = null;
  let error = $state('');
  let chatScroll = $state<HTMLDivElement>();
  let sidebarElement: HTMLElement;
  let chatArea: HTMLElement;
  let detailsArea = $state<HTMLElement>();

  async function showMobileView(view: 'sessions' | 'chat' | 'details') {
    saveViewState();
    if (acpAgent) {
      agentChangesOpen = view === 'details';
      if (agentChangesOpen) void refreshAgentDiff();
    }
    if (view === 'details') detailsOpen = true;
    mobileView = view;
    await tick();
    if (window.matchMedia('(max-width: 850px)').matches)
      (view === 'sessions' ? sidebarElement : view === 'details' ? detailsArea : chatArea)?.focus();
  }

  async function switchSideTab(tab: SideTab) {
    saveViewState();
    sideTab = tab;
    await tick();
    restoreSideScroll(viewStates.get(viewKey())?.sideScroll[activeSideTab as SideTab]);
    if (tab === 'changes') void refreshDiff();
  }

  async function toggleChanges() {
    if (acpAgent) {
      agentChangesOpen = !agentChangesOpen;
      if (window.matchMedia('(max-width: 850px)').matches)
        mobileView = agentChangesOpen ? 'details' : 'chat';
      if (agentChangesOpen) void refreshAgentDiff();
      return;
    }
    if (!sessionID) return;
    const narrow = window.matchMedia('(max-width: 850px)').matches;
    const visible =
      detailsOpen && activeSideTab === 'changes' && (!narrow || mobileView === 'details');
    saveViewState();
    if (visible) {
      detailsOpen = false;
      if (narrow) mobileView = 'chat';
      await tick();
      if (narrow) chatArea?.focus();
      return;
    }
    detailsOpen = true;
    sideTab = 'changes';
    if (narrow) mobileView = 'details';
    await tick();
    restoreSideScroll(viewStates.get(viewKey())?.sideScroll.changes);
    if (narrow) detailsArea?.focus();
    void refreshDiff();
  }

  async function refreshAgentDiff() {
    if (!directory) return;
    const path = directory;
    const generation = ++diffRefresh;
    diffLoading = true;
    try {
      const next = await invoke<FileDiffInfo[]>('working_tree_diff', { path });
      if (generation !== diffRefresh || path !== directory) return;
      diffs = next;
      diffError = '';
      selectedFilePath = selectedDiffFile(next, selectedFilePath, path);
    } catch (cause) {
      if (generation === diffRefresh) diffError = describe(cause);
    } finally {
      if (generation === diffRefresh) diffLoading = false;
    }
  }

  function restoreSideScroll(positions?: number[]) {
    const scrollable = detailsArea?.querySelectorAll<HTMLElement>(
      '.side-view:not(.inactive) :is(.panel-scroll, .diff-files, .patch-scroll, .history-list)',
    );
    scrollable?.forEach((element, index) => (element.scrollTop = positions?.[index] ?? 0));
  }

  function viewKey(path = directory, id = sessionID) {
    return `${path}\0${id ?? 'new'}`;
  }

  function saveViewState() {
    if (!directory || acpAgent) return;
    const previous = viewStates.get(viewKey());
    const narrow = window.matchMedia('(max-width: 850px)').matches;
    const chatVisible = !narrow || mobileView === 'chat';
    const detailsVisible = !narrow || mobileView === 'details';
    const currentChatScroll = chatScroll;
    const anchor = chatVisible
      ? [...(currentChatScroll?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(
          (element) =>
            currentChatScroll &&
            element.getBoundingClientRect().bottom > currentChatScroll.getBoundingClientRect().top,
        )
      : null;
    const scrollable = detailsArea?.querySelectorAll<HTMLElement>(
      '.side-view:not(.inactive) :is(.panel-scroll, .diff-files, .patch-scroll, .history-list)',
    );
    viewStates.set(viewKey(), {
      draft,
      scrollTop: chatVisible ? (chatScroll?.scrollTop ?? 0) : (previous?.scrollTop ?? 0),
      follow: chatVisible ? followChat : (previous?.follow ?? true),
      messageCount: chatVisible ? messages.length : (previous?.messageCount ?? 0),
      anchorID: chatVisible ? (anchor?.dataset.messageId ?? null) : (previous?.anchorID ?? null),
      anchorOffset:
        chatVisible && anchor && chatScroll
          ? anchor.getBoundingClientRect().top - chatScroll.getBoundingClientRect().top
          : (previous?.anchorOffset ?? 0),
      sideTab,
      selectedFilePath,
      sideScroll: detailsVisible
        ? {
            ...previous?.sideScroll,
            [activeSideTab]: [...(scrollable ?? [])].map((element) => element.scrollTop),
          }
        : (previous?.sideScroll ?? {}),
    });
  }

  async function restoreViewState() {
    const saved = viewStates.get(viewKey());
    draft = saved?.draft ?? '';
    if (saved && client && sessionID) {
      const id = sessionID;
      const current = selection;
      await restoreOlderMessages(client, id, current, saved.messageCount, saved.anchorID);
      if (current !== selection || id !== sessionID) return;
    }
    await tick();
    if (saved && chatScroll) {
      cancelAnimationFrame(followFrame);
      followChat = saved.follow;
      const anchor = saved.anchorID
        ? [...chatScroll.querySelectorAll<HTMLElement>('[data-message-id]')].find(
            (element) => element.dataset.messageId === saved.anchorID,
          )
        : null;
      chatScroll.scrollTop = saved.follow
        ? chatScroll.scrollHeight
        : anchor
          ? chatScroll.scrollTop +
            anchor.getBoundingClientRect().top -
            chatScroll.getBoundingClientRect().top -
            saved.anchorOffset
          : saved.scrollTop;
    }
    if (saved && detailsArea) restoreSideScroll(saved.sideScroll[activeSideTab as SideTab]);
  }

  async function restoreOlderMessages(
    source: OpenCodeClient,
    id: string,
    current: number,
    count: number,
    anchorID: string | null,
  ): Promise<void> {
    if (
      (anchorID ? messages.some((message) => message.id === anchorID) : messages.length >= count) ||
      !olderMessageCursor
    )
      return;
    const cursor = olderMessageCursor;
    const page = await source.message.list({ sessionID: id, limit: 50, cursor });
    if (current !== selection || id !== sessionID) return;
    messages = mergeMessages(messages, page.data);
    olderMessageCursor = page.cursor.next === cursor ? null : (page.cursor.next ?? null);
    await restoreOlderMessages(source, id, current, count, anchorID);
  }
  let client = $state<OpenCodeClient | null>(null);
  let eventController: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let diffTimer: ReturnType<typeof setTimeout> | undefined;
  let diffPollTimer: ReturnType<typeof setInterval> | undefined;
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
  let maxDetailsWidth = $derived(Math.max(320, workspaceWidth - 308));
  let visibleDetailsWidth = $derived(Math.min(detailsWidth, maxDetailsWidth));

  function planExpandedKey() {
    return `sai-plan-expanded:${encodeURIComponent(directory)}:${sessionID}`;
  }

  $effect(() => {
    const plan = snapshot.plan;
    if (
      !sessionID ||
      plan?.sessionID !== sessionID ||
      plan.version !== 1 ||
      running ||
      workspaceWidth === 0 ||
      localStorage.getItem(planExpandedKey())
    )
      return;
    detailsOpen = true;
    detailsWidth = Math.min(maxDetailsWidth, Math.round(workspaceWidth * 0.65));
    localStorage.setItem('sai-details-width', String(detailsWidth));
    localStorage.setItem(planExpandedKey(), '1');
  });

  function setDetailsWidth(width: number) {
    detailsWidth = Math.min(maxDetailsWidth, Math.max(320, Math.round(width)));
    localStorage.setItem('sai-details-width', String(detailsWidth));
    if (sessionID) localStorage.setItem(planExpandedKey(), '1');
  }

  function startDetailsResize(event: PointerEvent) {
    if (event.button !== 0) return;
    resizeStart = {
      x: event.clientX,
      width: detailsArea?.getBoundingClientRect().width ?? detailsWidth,
    };
    if (event.currentTarget instanceof HTMLElement)
      event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDetailsResize(event: PointerEvent) {
    if (!resizeStart) return;
    detailsWidth = Math.min(
      maxDetailsWidth,
      Math.max(320, Math.round(resizeStart.width + resizeStart.x - event.clientX)),
    );
  }

  function endDetailsResize() {
    if (!resizeStart) return;
    resizeStart = null;
    localStorage.setItem('sai-details-width', String(detailsWidth));
    if (sessionID) localStorage.setItem(planExpandedKey(), '1');
  }

  function keydownDetailsResize(event: KeyboardEvent) {
    const step = event.shiftKey ? 50 : 20;
    const width =
      event.key === 'ArrowLeft'
        ? visibleDetailsWidth + step
        : event.key === 'ArrowRight'
          ? visibleDetailsWidth - step
          : event.key === 'Home'
            ? 320
            : event.key === 'End'
              ? maxDetailsWidth
              : null;
    if (width === null) return;
    event.preventDefault();
    setDetailsWidth(width);
  }

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
    if (isTauri())
      void acp
        .agents()
        .then((agents) => (agentAvailability = agents))
        .catch((cause) => (runtimeError = `Could not detect agents: ${describe(cause)}`));
    const observer = new ResizeObserver(() => (workspaceWidth = workspaceElement.clientWidth));
    observer.observe(workspaceElement);
    void initialize();
    healthTimer = setInterval(() => void checkRuntime(), 5000);
    diffPollTimer = setInterval(() => {
      const visible = !window.matchMedia('(max-width: 850px)').matches || mobileView === 'details';
      if (acpAgent && agentChangesOpen && visible && !diffLoading) {
        void refreshAgentDiff();
        return;
      }
      if (
        !acpAgent &&
        detailsOpen &&
        activeSideTab === 'changes' &&
        sessionID &&
        visible &&
        !diffLoading
      )
        void refreshDiff(sessionID, selection, true);
    }, 3000);
    return () => {
      disposed = true;
      observer.disconnect();
      eventController?.abort();
      clearTimeout(refreshTimer);
      clearTimeout(diffTimer);
      clearTimeout(recoveryTimer);
      clearInterval(healthTimer);
      clearInterval(diffPollTimer);
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

  function saveProjectCatalog(next: ProjectCatalog) {
    projectCatalog = next;
    localStorage.setItem('sai-project-catalog', JSON.stringify(next));
  }

  function addProjectGroup(name: string) {
    if (projectCatalog.groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
      error = `Project group “${name}” already exists.`;
      return;
    }
    saveProjectCatalog({
      ...projectCatalog,
      groups: [
        ...projectCatalog.groups,
        { id: crypto.randomUUID(), name, collapsed: false, repositories: [] },
      ],
    });
  }

  function renameProjectGroup(id: string, name: string) {
    if (
      projectCatalog.groups.some(
        (group) => group.id !== id && group.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      error = `Project group “${name}” already exists.`;
      return;
    }
    saveProjectCatalog({
      ...projectCatalog,
      groups: projectCatalog.groups.map((group) => (group.id === id ? { ...group, name } : group)),
    });
  }

  function deleteProjectGroup(id: string) {
    saveProjectCatalog({
      ...projectCatalog,
      groups: projectCatalog.groups.filter((group) => group.id !== id),
    });
  }

  function toggleProjectGroup(id: string) {
    saveProjectCatalog({
      ...projectCatalog,
      groups: projectCatalog.groups.map((group) =>
        group.id === id ? { ...group, collapsed: !group.collapsed } : group,
      ),
    });
  }

  function moveProjectRepository(path: string, groupID: string | null) {
    saveProjectCatalog(assignRepository(projectCatalog, path, groupID));
  }

  function removeProjectRepository(path: string) {
    if (
      path !== directory &&
      !(projectCatalog.worktrees[path] ?? []).some((worktree) => worktree.path === directory)
    )
      saveProjectCatalog(removeRepository(projectCatalog, path));
  }

  async function createProjectWorktree(
    path: string,
    name: string,
    destinationParent: string | null,
    baseRef: string | null,
  ) {
    const created = await invoke<{ path: string; branch: string; base: string }>(
      'create_worktree',
      {
        repository: path,
        name,
        destinationParent,
        baseRef,
      },
    );
    saveProjectCatalog(addWorktree(projectCatalog, path, created));
    await loadProject(created.path);
  }

  async function chooseProject(groupID: string | null = null) {
    const selected = await open({ directory: true, multiple: false, title: 'Choose a repository' });
    if (typeof selected !== 'string') return;
    try {
      const path = await invoke<string>('validate_repository', { path: selected });
      if (
        !projectCatalog.repositories.includes(path) &&
        !Object.values(projectCatalog.worktrees).some((worktrees) =>
          worktrees.some((worktree) => worktree.path === path),
        )
      )
        saveProjectCatalog(assignRepository(projectCatalog, path, groupID));
      if (path !== directory) await loadProject(path);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function loadProject(path: string) {
    saveViewState();
    error = '';
    const current = ++selection;
    directory = path;
    localStorage.setItem('sai-directory', path);
    acpAgent = null;
    acpThread = null;
    ++sessionRefresh;
    workReady = false;
    planReady = false;
    setup = null;
    selectedAgentID = '';
    selectedModelKey = '';
    attachedFiles = [];
    setupOpen = true;
    sessionID = null;
    mobileView = 'chat';
    newSessionMode = null;
    selectedSession = null;
    sessions = [];
    activeSessionIDs = [];
    sessionSearch = '';
    sessionCursor = undefined;
    nextSessionCursor = null;
    sessionPageHistory = [];
    resetTimeline();
    draft = '';
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
    if (!client || !(await refreshSetup(path)) || current !== selection) return;
    draft = viewStates.get(viewKey())?.draft ?? '';
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
      if (path !== report.repository) {
        saveProjectCatalog(replaceRepositoryPath(projectCatalog, path, report.repository));
        agentThreads = agentThreads.map((thread) =>
          thread.directory === path
            ? Object.assign({}, thread, { directory: report.repository })
            : thread,
        );
        saveAgentThreads(agentThreads);
        if (acpThread?.directory === path)
          acpThread = Object.assign({}, acpThread, { directory: report.repository });
      }
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
        matches.push(
          ...result.data.filter(
            (session) => session.location.directory === path && !session.parentID,
          ),
        );
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
            if (info.location.directory === path && !info.parentID) {
              selectedSession = info;
              syncSessionChoice(info);
            } else {
              clearSelectedSession();
              error = 'This session does not belong to the selected repository.';
            }
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
    saveViewState();
    sessionID = null;
    mobileView = 'chat';
    selectedSession = null;
    resetTimeline();
    snapshot = { plan: null, questions: null };
    attachedFiles = [];
    running = false;
    pendingPermissions = [];
    pendingForms = [];
    localStorage.removeItem(`sai-session:${directory}`);
  }

  function openAgent(agent: AgentId, thread: AgentThread | null = null) {
    if (!directory) return;
    saveViewState();
    acpAgent = agent;
    acpThread = thread;
    mobileView = 'chat';
    setupOpen = false;
  }

  function saveAgentThread(thread: AgentThread) {
    agentThreads = [
      thread,
      ...agentThreads.filter(
        (item) => item.agent !== thread.agent || item.sessionId !== thread.sessionId,
      ),
    ].toSorted((a, b) => b.updated - a.updated);
    saveAgentThreads(agentThreads);
    if (acpAgent === thread.agent && acpThread?.sessionId === thread.sessionId) acpThread = thread;
  }

  function createAgentThread(thread: AgentThread) {
    saveAgentThread(thread);
    if (acpAgent === thread.agent && directory === thread.directory && !acpThread)
      acpThread = thread;
  }

  function removeAgentThread(thread: AgentThread) {
    agentThreads = agentThreads.filter(
      (item) => item.agent !== thread.agent || item.sessionId !== thread.sessionId,
    );
    saveAgentThreads(agentThreads);
    if (acpThread?.sessionId === thread.sessionId && acpAgent === thread.agent)
      openAgent(thread.agent);
  }

  async function selectSession(id: string) {
    if (!client || !directory) return;
    acpAgent = null;
    acpThread = null;
    if (sessionID || newSessionMode || draft !== (viewStates.get(viewKey())?.draft ?? ''))
      saveViewState();
    const current = ++selection;
    const path = directory;
    let info: SessionInfo;
    try {
      info = await client.session.get({ sessionID: id });
      if (current !== selection || path !== directory) return;
      if (info.location.directory !== path || info.parentID)
        throw new Error('This session does not belong to the selected repository.');
    } catch (cause) {
      if (current === selection && path === directory) error = describe(cause);
      return;
    }
    sessionID = id;
    detailsOpen = true;
    selectedSession = info;
    syncSessionChoice(info);
    newSessionMode = null;
    attachedFiles = [];
    resetTimeline();
    followChat = viewStates.get(viewKey())?.follow ?? true;
    running = activeSessionIDs.includes(id);
    activity = 'Thinking';
    activityTool = '';
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
    sideTab = viewStates.get(viewKey())?.sideTab ?? 'plan';
    selectedFilePath = viewStates.get(viewKey())?.selectedFilePath ?? null;
    mobileView = 'chat';
    error = '';
    localStorage.setItem(`sai-session:${directory}`, id);
    await refreshSession(id, current);
    if (current === selection) {
      await restoreViewState();
      if (window.matchMedia('(max-width: 850px)').matches) chatArea?.focus();
    }
  }

  function syncSessionChoice(session: SessionInfo) {
    if (session.agent) selectedAgentID = session.agent;
    if (session.model) selectedModelKey = modelKey(session.model);
  }

  function newWork() {
    if (!workReady || switching || sending) return;
    acpAgent = null;
    acpThread = null;
    saveViewState();
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
    draft = viewStates.get(viewKey())?.draft ?? '';
    mobileView = 'chat';
    error = '';
  }

  async function newPlan() {
    if (!client || !directory || !planReady || switching || sending) return;
    acpAgent = null;
    acpThread = null;
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

  async function refreshDiff(id = sessionID, current = selection, quiet = false) {
    if (acpAgent || !client || !id || !directory) return;
    const source = client;
    const path = directory;
    const generation = ++diffRefresh;
    if (!quiet) diffLoading = true;
    try {
      const next = (await source.vcs.diff({ location: { directory: path }, mode: 'working' })).data;
      if (
        acpAgent ||
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
      if (!acpAgent && generation === diffRefresh && current === selection && id === sessionID)
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
    saveViewState();
    detailsOpen = true;
    sideTab = 'changes';
    mobileView = 'details';
    void focusDiffDetails();
    const key = repoPath(path, directory);
    selectedFilePath =
      (key ? diffs.find((file) => repoPath(file.file, directory) === key)?.file : undefined) ??
      path;
  }

  async function focusDiffDetails() {
    await tick();
    restoreSideScroll(viewStates.get(viewKey())?.sideScroll.changes);
    if (window.matchMedia('(max-width: 850px)').matches) detailsArea?.focus();
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

  function scheduleDiffRefresh() {
    clearTimeout(diffTimer);
    diffTimer = setTimeout(() => void refreshDiff(), 120);
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
        if (event.type === 'filesystem.changed' && event.location?.directory === directory)
          scheduleDiffRefresh();
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
            activity = 'Writing response';
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
          if (event.type === 'session.execution.started') {
            running = true;
            activity = 'Thinking';
            activityTool = '';
          }
          if (event.type === 'session.reasoning.started') activity = 'Thinking';
          if (event.type === 'session.text.started') activity = 'Writing response';
          if (event.type === 'session.tool.input.started') {
            activityTool = event.data.name;
            activity = `Preparing ${activityTool}`;
          }
          if (event.type === 'session.tool.called')
            activity = activityTool ? `Using ${activityTool}` : 'Using a tool';
          if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
            activity = 'Thinking';
            activityTool = '';
            scheduleDiffRefresh();
          }
          if (event.type === 'session.compaction.started') activity = 'Organizing context';
          if (event.type === 'session.retry.scheduled') activity = 'Retrying';
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
    viewStates.delete(viewKey());
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
      if (current === selection && path === directory) {
        running = true;
        activity = 'Thinking';
        activityTool = '';
      }
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

  function keydownWorkspace(event: KeyboardEvent) {
    if (
      (!acpAgent && !sessionID) ||
      event.repeat ||
      event.key.toLowerCase() !== 'l' ||
      !(event.metaKey || event.ctrlKey) ||
      event.altKey ||
      event.shiftKey ||
      document.querySelector('dialog[open]')
    )
      return;
    event.preventDefault();
    void toggleChanges();
  }

  function focusWorkspace() {
    if (acpAgent && agentChangesOpen) void refreshAgentDiff();
    else if (!acpAgent && detailsOpen && activeSideTab === 'changes') void refreshDiff();
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

<svelte:head><title>Sail · Plan workspace</title></svelte:head>
<svelte:window onkeydown={keydownWorkspace} onfocus={focusWorkspace} />
<div class="app-shell" data-mobile-view={mobileView}>
  <aside
    class="sidebar"
    aria-label="Projects and sessions"
    tabindex="-1"
    bind:this={sidebarElement}
  >
    <div class="brand"><span class="brand-mark">S.</span><span>Sail</span></div>
    <ProjectSidebar
      catalog={projectCatalog}
      {directory}
      disabled={runtimeState !== 'connected' && !agentAvailability.some((agent) => agent.available)}
      onselect={(path) => {
        if (path !== directory) void loadProject(path);
      }}
      onaddrepository={(groupID) => void chooseProject(groupID)}
      onaddgroup={addProjectGroup}
      onrenamegroup={renameProjectGroup}
      ondeletegroup={deleteProjectGroup}
      ontogglegroup={toggleProjectGroup}
      onmoverepository={moveProjectRepository}
      onremoverepository={removeProjectRepository}
      oncreateworktree={createProjectWorktree}
    />
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
    <div class="session-heading"><span class="label">OTHER AGENTS</span></div>
    <div class="agent-launches">
      {#each agentAvailability as agent (agent.id)}
        <Button
          size="sm"
          variant="ghost"
          disabled={!directory || !agent.available}
          title={agent.reason ?? `New ${agent.name} thread`}
          onclick={() => openAgent(agent.id)}>+ {agent.name}</Button
        >
      {/each}
    </div>
    {#each agentThreads.filter((thread) => thread.directory === directory) as thread (`${thread.agent}:${thread.sessionId}`)}
      <div
        class:active={acpAgent === thread.agent && acpThread?.sessionId === thread.sessionId}
        class="session-row"
      >
        <button
          class="session-item"
          aria-current={acpAgent === thread.agent && acpThread?.sessionId === thread.sessionId
            ? 'page'
            : undefined}
          onclick={() => openAgent(thread.agent, thread)}
          title={thread.title}
        >
          <span class="session-symbol">◇</span><span class="session-details"
            ><strong>{thread.title}</strong><small
              >{thread.agent} · {new Date(thread.updated).toLocaleString()}</small
            ></span
          >
        </button>
        <button
          class="session-action"
          aria-label={`Remove ${thread.title} from Sail`}
          onclick={() => removeAgentThread(thread)}>×</button
        >
      </div>
    {/each}
    {#if directory}<input
        class="session-search"
        aria-label="Search sessions"
        placeholder="Search sessions"
        bind:value={sessionSearch}
        oninput={changeSearch}
      />{/if}
    <nav class="session-list" aria-label="Sessions">
      {#each visibleSessions as session (session.id)}<div
          class:active={!acpAgent && session.id === sessionID}
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
              aria-current={!acpAgent && session.id === sessionID ? 'page' : undefined}
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
    <div class="sidebar-footer" role="status">
      <span class:connected={runtimeState === 'connected'} class="status-dot" aria-hidden="true"
      ></span><span>OpenCode {runtimeState}</span>
    </div>
  </aside>
  <div class="main-area">
    <header class="topbar">
      <nav class="mobile-switcher" aria-label="Workspace panels">
        <button aria-pressed={mobileView === 'sessions'} onclick={() => showMobileView('sessions')}
          >Sessions</button
        >
        <button aria-pressed={mobileView === 'chat'} onclick={() => showMobileView('chat')}
          >Chat</button
        >
        <button
          aria-pressed={mobileView === 'details'}
          disabled={!sessionID && !acpAgent}
          onclick={() => showMobileView('details')}>Details</button
        >
      </nav>
      <div class="breadcrumb">
        <button
          class="breadcrumb-project"
          onclick={() => chooseProject()}
          disabled={runtimeState !== 'connected' &&
            !agentAvailability.some((agent) => agent.available)}
          >{directory ? directory.split('/').filter(Boolean).at(-1) : 'Workspace'} ⌄</button
        ><span class="slash">/</span><strong
          >{acpAgent
            ? (acpThread?.title ?? `New ${acpAgent} thread`)
            : (currentSession?.title ??
              (newSessionMode === 'work' ? 'New work' : 'New session'))}</strong
        >
      </div>
      <div class="topbar-actions">
        {#if sessionID || acpAgent}<Button
            variant="ghost"
            size="sm"
            onclick={toggleChanges}
            aria-controls="session-details"
            aria-expanded={acpAgent ? agentChangesOpen : detailsOpen && activeSideTab === 'changes'}
            title="Toggle Changes (⌘L)">Changes</Button
          >{/if}
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
        <details class="runtime-settings">
          <summary>Agent settings</summary>
          <div class="runtime-settings-panel">
            {#each agentAvailability as agent (agent.id)}
              <p class="runtime-binary">
                <strong>{agent.name}</strong>: {agent.binaryPath ?? agent.reason ?? 'Unavailable'}
              </p>
            {/each}
            <Button
              size="sm"
              onclick={() => void acp.agents().then((agents) => (agentAvailability = agents))}
              >Detect again</Button
            >
          </div>
        </details>
        {#if !acpAgent}<span role="status"
            ><Badge tone={workReady ? 'success' : 'neutral'}
              >{running ? 'Running' : workReady ? 'Ready' : 'Setup needed'}</Badge
            ></span
          >{/if}<Button variant="ghost" size="sm" onclick={() => setTheme(!dark)}
          >{dark ? 'Light' : 'Dark'} theme</Button
        >
      </div>
    </header>
    {#if !acpAgent && setupOpen && (directory || setupError)}<section
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
              Install the tested plugin revision with <code
                >opencode plugin add
                github:smykla-skalski/opencode-plugin-plan-review#fdc575ba5ffccc6420ad5b3b68372f99f70290f5</code
              >, or add a local checkout path to <code>opencode.jsonc</code>:
            </p>
            <pre>{'{ "plugins": ["/absolute/path/to/opencode-plugin-plan-review"] }'}</pre>
            <p>
              Choose <strong>Restart and check</strong> after changing plugin configuration. This app
              does not change your repository.
            </p>
          </div>{/if}
      </section>{/if}
    <div
      class:single={acpAgent ? !agentChangesOpen : !sessionID || !detailsOpen}
      class:closed={acpAgent ? !agentChangesOpen : !detailsOpen}
      class="workspace"
      style={`--details-width: ${visibleDetailsWidth}px`}
      bind:this={workspaceElement}
    >
      <main class="chat-area" aria-label="Session conversation" tabindex="-1" bind:this={chatArea}>
        {#if acpAgent}
          {#key acpAgent}
            <AgentWorkspace
              agent={acpAgent}
              agentName={agentAvailability.find((agent) => agent.id === acpAgent)?.name ?? acpAgent}
              {directory}
              thread={acpThread}
              oncreated={createAgentThread}
              onactivity={saveAgentThread}
            />
          {/key}
        {:else}
          <div
            class="conversation"
            bind:this={chatScroll}
            onscroll={() => (followChat = chatScroll ? nearBottom(chatScroll) : true)}
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
                  Choose an agent and model, then describe the work. Use New plan for
                  Architect-first planning.
                </p>
                {#if !directory}<Button
                    onclick={() => chooseProject()}
                    disabled={runtimeState !== 'connected'}>Select repository</Button
                  >{/if}
              </div>{/if}
            {#each chatMessages as message (message.id)}
              {#if message.type === 'user'}<article
                  class="message user-message"
                  data-message-id={message.id}
                >
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
              {:else if message.type === 'assistant'}<article
                  class="message assistant-message"
                  data-message-id={message.id}
                >
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
            {#if running && runtimeState === 'connected'}<div class="working">
                <span class="activity-spinner" aria-hidden="true"></span>
                <span class="working-label" role="status"
                  >{currentSession?.agent ?? 'Agent'} · {activity}</span
                >
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
                aria-label="Message"
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
        {/if}
      </main>
      {#if sessionID || acpAgent}<div
          class="details-resizer"
          role="slider"
          tabindex="0"
          aria-label="Pane divider position"
          aria-orientation="horizontal"
          aria-controls="session-details"
          aria-valuemin="300"
          aria-valuemax={Math.max(300, workspaceWidth - 328)}
          aria-valuenow={Math.max(300, workspaceWidth - 8 - visibleDetailsWidth)}
          aria-valuetext={`Details pane ${visibleDetailsWidth} pixels wide`}
          onpointerdown={startDetailsResize}
          onpointermove={moveDetailsResize}
          onpointerup={endDetailsResize}
          onpointercancel={endDetailsResize}
          onkeydown={keydownDetailsResize}
          ondblclick={() => setDetailsWidth(420)}
        ></div>
        <section
          id="session-details"
          class="side-area"
          aria-label="Session details"
          tabindex="-1"
          bind:this={detailsArea}
        >
          <nav class="side-tabs" aria-label="Session detail tabs">
            {#if !acpAgent && showPlanPanel}<button
                class:active={activeSideTab === 'plan'}
                aria-current={activeSideTab === 'plan' ? 'page' : undefined}
                onclick={() => switchSideTab('plan')}>Plan</button
              >{/if}<button
              class:active={acpAgent || activeSideTab === 'changes'}
              aria-current={acpAgent || activeSideTab === 'changes' ? 'page' : undefined}
              onclick={toggleChanges}>Changes ({diffs.length})</button
            >{#if !acpAgent}<button
                class:active={activeSideTab === 'history'}
                aria-current={activeSideTab === 'history' ? 'page' : undefined}
                onclick={() => switchSideTab('history')}>History</button
              >{/if}
          </nav>
          <div class="side-panel-body">
            {#if !acpAgent && showPlanPanel}<div
                class:inactive={activeSideTab !== 'plan'}
                class="side-view"
              >
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
            <div class:inactive={!acpAgent && activeSideTab !== 'changes'} class="side-view">
              <DiffPanel
                files={diffs}
                annotations={acpAgent ? {} : diffAnnotations}
                selected={selectedFilePath}
                loading={diffLoading}
                error={diffError}
                onselect={(file) => (selectedFilePath = file)}
                onrefresh={() => (acpAgent ? refreshAgentDiff() : refreshDiff())}
                onclose={toggleChanges}
              />
            </div>
            {#if !acpAgent}<div class:inactive={activeSideTab !== 'history'} class="side-view">
                <HistoryPanel
                  events={historyEvents}
                  session={currentSession}
                  loading={historyLoading}
                  error={historyError}
                  onrefresh={() => refreshHistory()}
                />
              </div>{/if}
          </div>
        </section>{/if}
    </div>
  </div>
</div>
