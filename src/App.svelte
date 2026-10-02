<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { emitTo, listen } from '@tauri-apps/api/event';
  import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { open } from '@tauri-apps/plugin-dialog';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { isPermissionNotFoundError, isSessionNotFoundError } from '@opencode/client';
  import type { FormInfo, PermissionRequest } from '@opencode/client';
  import type { ModelRef } from '@opencode/client';
  import type { BrowserAttachment } from './lib/browser-pick';
  import { Badge, Button } from '@smykla-skalski/sui';
  import Markdown from './Markdown.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import DiffPanel from './DiffPanel.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import PromptPanel from './PromptPanel.svelte';
  import ProjectSidebar from './ProjectSidebar.svelte';
  import AgentWorkspace from './AgentWorkspace.svelte';
  import PaneTree from './PaneTree.svelte';
  import InboxPanel from './InboxPanel.svelte';
  import {
    inboxLocations,
    loadInboxSeen,
    maxInboxSeen,
    openCodeRequestTime,
    sortInbox,
    type InboxItem,
  } from './lib/inbox';
  import {
    newestAvailableThread,
    searchCommandPalette,
    type PaletteEntry,
  } from './lib/command-palette';
  import {
    loadRecentThreadKeys,
    migrateRecentThreadKeys,
    nextRecentIndex,
    retainRecentThreads,
    threadKey,
    touchRecentThread,
  } from './lib/recent-threads';
  import {
    loadAttention,
    markAttentionRead,
    reconcileAttention,
    updateAttention,
    type AttentionMap,
    type ThreadStatus,
  } from './lib/attention';
  import {
    adjacentPaneId,
    closePane,
    leaves,
    loadPaneLayouts,
    mainPane,
    minPaneSpan,
    migratePaneDirectory,
    newBrowserTab,
    splitPane,
    updatePane,
    type BrowserTab,
    type Pane,
  } from './lib/panes';
  import {
    acp,
    loadAgentThreads,
    saveAgentThreads,
    type AgentAvailability,
    type AgentEvent,
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
  import { getSetting, removeSetting, setSetting, settingsError } from './lib/settings';
  import {
    commandsForDirectory,
    loadSavedCommands,
    selectedRepository,
    type SavedCommand,
  } from './lib/saved-commands';
  import { annotateDiffs, repoPath, selectedDiffFile, type WorkingDiffInfo } from './lib/diff';
  import type { DiffComment } from './lib/diff-comments';
  import { inspectRepository, type SetupReport } from './lib/onboarding';
  import {
    settingsAction,
    settingsRequest,
    settingsState,
    type SettingsAction,
    type SettingsSnapshot,
  } from './lib/settings-window';
  import {
    addWorktree,
    assignRepository,
    loadProjectCatalog,
    removeRepository,
    removeWorktree,
    replaceRepositoryPath,
    setWorktreePullRequest,
    type ProjectCatalog,
    type ProjectWorktree,
  } from './lib/projects';

  let dark = $state(getSetting('sai-theme') === 'dark');
  const savedAgentThreads = loadAgentThreads();
  const savedDirectory = getSetting('sai-directory') ?? savedAgentThreads[0]?.directory ?? '';
  let directory = $state(savedDirectory);
  let projectCatalog = $state<ProjectCatalog>(
    loadProjectCatalog(getSetting('sai-project-catalog'), savedDirectory),
  );
  let savedCommands = $state<SavedCommand[]>(loadSavedCommands(getSetting('sai-saved-commands')));
  let pendingCommands = $state<Record<string, string>>({});
  let browserAccessDisabled = $state(
    getSetting(`sai-browser-disabled:${savedDirectory}`) === 'true',
  );
  const openCodeBrowserServers = new SvelteSet<string>();
  type BrowserMcpConfig = { command: string; args: string[]; env: Record<string, string> };
  type BrowserAccessRequest = { id: string; sessionId: string; directory: string; origin?: string };
  let browserApprovalQueue: Promise<unknown> = Promise.resolve();
  type WorktreeConfig = { setup: string; run: string; archive: string; copy: string[] };
  let selectedWorktreeConfig = $state<WorktreeConfig | null>(null);
  let configGeneration = 0;
  const terminalExitWaiters = new SvelteMap<string, (code: number) => void>();
  $effect(() => {
    const path = directory;
    const generation = ++configGeneration;
    selectedWorktreeConfig = null;
    if (!path || !isTauri()) return;
    void invoke<WorktreeConfig | null>('worktree_config', { worktree: path })
      .then((config) => {
        if (generation === configGeneration) selectedWorktreeConfig = config;
        return config;
      })
      .catch((cause) => {
        if (generation === configGeneration) error = describe(cause);
        return null;
      });
  });
  let agentTerminals = $state<
    {
      agent: string;
      sessionId: string;
      terminalId: string;
      command: string;
      directory: string;
    }[]
  >([]);
  let agentTerminalsDialog: HTMLDialogElement;
  let commandsDialog: HTMLDialogElement;
  let commandName = $state('');
  let commandText = $state('');
  let commandScope = $state<'global' | 'project'>('global');
  let editingCommand = $state<string | null>(null);
  let binaryPath = $state(getSetting('sai-opencode-bin') ?? '');
  let appliedBinaryPath = getSetting('sai-opencode-bin') ?? '';
  let activeBinary = $state('');
  let agentAvailability = $state<AgentAvailability[]>([]);
  let agentDetectionError = $state('');
  let agentThreads = $state<AgentThread[]>(savedAgentThreads);
  let threadAttention = $state<AttentionMap>(loadAttention(getSetting('sai-thread-attention')));
  let attentionRevision = 0;
  let notificationsEnabled = $state(getSetting('sai-notifications-enabled') !== 'false');
  let notificationSound = $state(getSetting('sai-notification-sound') !== 'false');
  let inboxItems = $state<InboxItem[]>([]);
  let inboxLoading = $state(false);
  let inboxError = $state('');
  let inboxDialog: HTMLDialogElement;
  let inboxRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let inboxGeneration = 0;
  const inboxSeen = loadInboxSeen(getSetting('sai-inbox-seen'));
  let recentThreadKeys = $state<string[]>(
    loadRecentThreadKeys(getSetting('sai-recent-agent-threads'), savedAgentThreads),
  );
  let recentCycleKeys: string[] | null = null;
  let recentCycleIndex = -1;
  let recentJumpGeneration = 0;
  let paletteQuery = $state('');
  let paletteIndex = $state(0);
  let promptFocusPane = $state<string | null>(null);
  let paletteDialog: HTMLDialogElement;
  let paletteInput: HTMLInputElement;
  let palettePreviousFocus: HTMLElement | null = null;
  let restorePaletteFocus = true;
  const paletteEntries = $derived(
    searchCommandPalette(
      projectCatalog,
      agentThreads,
      agentAvailability,
      directory,
      paletteQuery,
      savedCommands,
    ),
  );
  let runningAgentThreads = $state<Record<string, boolean>>({});
  const savedPaneLayouts = loadPaneLayouts(getSetting('sai-pane-layouts'));
  let paneLayouts = $state<Record<string, Pane>>(savedPaneLayouts);
  let focusedPane = $state(leaves(savedPaneLayouts[savedDirectory] ?? mainPane())[0]?.id ?? 'main');
  let paneLayout = $derived(paneLayouts[directory] ?? mainPane());
  let agentChangesOpen = $state(false);
  let changesPanes = $state<string[]>([]);
  const initialMainPane = leaves(savedPaneLayouts[savedDirectory] ?? mainPane()).find(
    (leaf) => leaf.id === 'main',
  );
  let acpAgent = $state<AgentId | null>(initialMainPane?.agent ?? null);
  let acpThread = $state<AgentThread | null>(initialMainPane?.thread ?? null);
  let runtimeState = $state<'starting' | 'connected' | 'error'>('starting');
  let runtimeError = $state('');
  let workReady = $state(false);
  let planReady = $state(false);
  let selectedAgentID = $state('');
  let selectedModelKey = $state('');
  let newSessionMode = $state<'work' | null>(null);
  let attachedFiles = $state<string[]>([]);
  let pickedAttachments = $state<Record<string, BrowserAttachment>>({});
  let diffComments = $state<Record<string, DiffComment[]>>({});
  let pendingAgentBatches = $state<Record<string, { id: string; text: string }>>({});
  const batchWaiters = new SvelteMap<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  const pickedImageText = new SvelteMap<string, string>();
  const inFlightCaptures = new SvelteSet<string>();
  let setup = $state<SetupReport | null>(null);
  let setupError = $state('');
  let setupLoading = $state(false);
  let openingSettings = false;
  let settingsCreation: Promise<void> | null = null;
  let closingMain = false;
  const setupRestarted = new SvelteSet<string>();
  let lastSetupProbe = 0;
  let setupProbeCount = 0;
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
  let diffs = $state<WorkingDiffInfo[]>([]);
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
  const savedDetailsWidth = Number(getSetting('sai-details-width'));
  let detailsWidth = $state(
    Number.isFinite(savedDetailsWidth) && savedDetailsWidth >= 320 ? savedDetailsWidth : 420,
  );
  let workspaceWidth = $state(0);
  let workspaceElement = $state<HTMLDivElement>();
  let resizeStart: { x: number; width: number } | null = null;
  let error = $state('');
  let chatScroll = $state<HTMLDivElement>();
  let sidebarElement: HTMLElement;
  let chatArea: HTMLElement;
  let detailsArea = $state<HTMLElement>();

  $effect(() => {
    if (!workspaceElement) return;
    const element = workspaceElement;
    const observer = new ResizeObserver(() => (workspaceWidth = element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  });

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
    if (focusedPane !== 'main') {
      changesPanes = changesPanes.includes(focusedPane)
        ? changesPanes.filter((id) => id !== focusedPane)
        : [...changesPanes, focusedPane];
      return;
    }
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
      const next = await invoke<WorkingDiffInfo[]>('working_tree_diff', { path });
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
      draft: draftWithoutPickedImages(draft),
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
  let projectLoadGeneration = 0;
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
      getSetting(planExpandedKey())
    )
      return;
    detailsOpen = true;
    detailsWidth = Math.min(maxDetailsWidth, Math.round(workspaceWidth * 0.65));
    setSetting('sai-details-width', String(detailsWidth));
    setSetting(planExpandedKey(), '1');
  });

  function setDetailsWidth(width: number) {
    detailsWidth = Math.min(maxDetailsWidth, Math.max(320, Math.round(width)));
    setSetting('sai-details-width', String(detailsWidth));
    if (sessionID) setSetting(planExpandedKey(), '1');
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
    setSetting('sai-details-width', String(detailsWidth));
    if (sessionID) setSetting(planExpandedKey(), '1');
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

  function setTheme(value: boolean) {
    dark = value;
    document.documentElement.dataset.suiTheme = value ? 'dark' : 'light';
    setSetting('sai-theme', value ? 'dark' : 'light');
  }

  function settingsSnapshot(): SettingsSnapshot {
    return {
      theme: dark ? 'dark' : 'light',
      binaryPath,
      activeBinary,
      runtimeState,
      runtimeError,
      directory,
      setup,
      setupLoading,
      setupError,
      busy: connecting || running || sending,
      agents: agentAvailability,
      agentsError: agentDetectionError,
      notificationsEnabled,
      notificationSound,
    };
  }

  async function sendSettingsState() {
    try {
      await emitTo('settings', settingsState, settingsSnapshot());
    } catch (cause) {
      error = `Could not sync settings: ${describe(cause)}`;
    }
  }

  async function detectAgents() {
    agentDetectionError = '';
    try {
      agentAvailability = await acp.agents();
    } catch (cause) {
      agentDetectionError = `Could not detect agents: ${describe(cause)}`;
    }
    await sendSettingsState();
  }

  async function openSettings() {
    if (openingSettings || closingMain) return;
    openingSettings = true;
    try {
      const existing = await WebviewWindow.getByLabel('settings');
      if (closingMain) return;
      if (existing) {
        await existing.show();
        await existing.setFocus();
        await sendSettingsState();
        return;
      }
      const created = new WebviewWindow('settings', {
        url: 'index.html?window=settings',
        title: 'Sail Settings',
        width: 760,
        height: 620,
        minWidth: 520,
        minHeight: 420,
        center: true,
      });
      settingsCreation = new Promise<void>((resolve, reject) => {
        void created.once('tauri://created', () => resolve());
        void created.once('tauri://error', (event) => reject(event.payload));
      });
      await settingsCreation;
      if (closingMain) await created.close();
      else await created.setFocus();
    } catch (cause) {
      error = `Could not open settings: ${describe(cause)}`;
    } finally {
      settingsCreation = null;
      openingSettings = false;
    }
  }

  onMount(() => {
    let unlistenAgentEvents: (() => void) | undefined;
    let unlistenBrowserAccess: (() => void) | undefined;
    let unlistenAgentTerminals: (() => void) | undefined;
    let unlistenNotificationClick: (() => void) | undefined;
    setTheme(dark);
    let stopSettingsRequest: (() => void) | undefined;
    let stopSettingsAction: (() => void) | undefined;
    let stopCloseRequest: (() => void) | undefined;
    let stopPaneClose: (() => void) | undefined;
    if (isTauri()) {
      void listen<BrowserAccessRequest>('browser:access-request', ({ payload }) => {
        const previousApproval = browserApprovalQueue;
        browserApprovalQueue = (async () => {
          try {
            await previousApproval;
          } catch {
            error = 'A previous browser approval could not be completed.';
          }
          let allow = false;
          try {
            allow = await ask(
              payload.origin
                ? `Allow agent thread ${payload.sessionId} to use ${payload.origin} in the browser pane?`
                : `Allow agent thread ${payload.sessionId} to control the browser pane in ${payload.directory}?`,
              { title: 'Agent browser access', kind: 'warning' },
            );
          } catch (cause) {
            error = describe(cause);
          } finally {
            await invoke('browser_access_reply', { id: payload.id, allow });
          }
          return allow;
        })();
      }).then((unlisten) => (unlistenBrowserAccess = unlisten));
      void listen('pane:close', () => {
        if (!document.querySelector('dialog[open]')) closeCurrentPane();
      }).then((unlisten) => (stopPaneClose = unlisten));
      void getCurrentWindow()
        .onCloseRequested((event) => {
          event.preventDefault();
          if (closingMain) return;
          closingMain = true;
          void (async () => {
            try {
              await settingsCreation?.catch(() => undefined);
              const settings = await WebviewWindow.getByLabel('settings');
              if (settings) await settings.destroy();
              await getCurrentWindow().destroy();
            } catch (cause) {
              closingMain = false;
              error = `Could not close settings: ${describe(cause)}`;
            }
          })();
        })
        .then((unlisten) => (stopCloseRequest = unlisten));
      void listen(settingsRequest, () => void sendSettingsState()).then(
        (unlisten) => (stopSettingsRequest = unlisten),
      );
      void listen<SettingsAction>(settingsAction, (event) => {
        const action = event.payload;
        if (action.type === 'theme') setTheme(action.value === 'dark');
        else if (action.type === 'binary') {
          binaryPath = action.value;
          void retryRuntime();
        } else if (action.type === 'notifications') {
          notificationsEnabled = action.value;
          setSetting('sai-notifications-enabled', String(action.value));
        } else if (action.type === 'notification-sound') {
          notificationSound = action.value;
          setSetting('sai-notification-sound', String(action.value));
        } else if (action.type === 'detect-agents') void detectAgents();
        else if (action.type === 'restart-setup') void restartSetup();
        void sendSettingsState();
      }).then((unlisten) => (stopSettingsAction = unlisten));
    }
    if (isTauri()) void detectAgents();
    if (isTauri()) {
      void listen<(typeof agentTerminals)[number]>('acp-terminal-created', ({ payload }) => {
        agentTerminals = [...agentTerminals, payload];
      }).then((unlisten) => (unlistenAgentTerminals = unlisten));
      void listen<AgentEvent>('acp-event', ({ payload }) => handleAgentEvent(payload)).then(
        (unlisten) => {
          if (disposed) unlisten();
          else {
            unlistenAgentEvents = unlisten;
            void restoreAgentActivity();
            scheduleInboxRefresh();
          }
          return undefined;
        },
      );
      void listen<string>('sail-notification-click', ({ payload }) => {
        void jumpToRecentThread(payload);
      }).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenNotificationClick = unlisten;
        return undefined;
      });
      updateAttentionBadge();
    }
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
      stopSettingsRequest?.();
      stopSettingsAction?.();
      stopCloseRequest?.();
      stopPaneClose?.();
      disposed = true;
      eventController?.abort();
      clearTimeout(refreshTimer);
      clearTimeout(diffTimer);
      clearTimeout(recoveryTimer);
      clearTimeout(inboxRefreshTimer);
      clearInterval(healthTimer);
      clearInterval(diffPollTimer);
      unlistenAgentEvents?.();
      unlistenBrowserAccess?.();
      unlistenAgentTerminals?.();
      unlistenNotificationClick?.();
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

  async function ensureOpenCodeBrowser(path: string) {
    if (!client || openCodeBrowserServers.has(path)) return;
    const config = await invoke<BrowserMcpConfig>('browser_mcp_config', { directory: path });
    await client.mcp.add({
      server: 'sail-browser',
      location: { directory: path },
      config: {
        type: 'local',
        command: [config.command, ...config.args],
        environment: config.env,
        codemode: false,
      },
    });
    openCodeBrowserServers.add(path);
  }

  function toggleAgentBrowserAccess() {
    if (!directory) return;
    browserAccessDisabled = !browserAccessDisabled;
    setSetting(`sai-browser-disabled:${directory}`, String(browserAccessDisabled));
    void invoke('browser_project_access', {
      directory,
      enabled: !browserAccessDisabled,
    }).catch((cause) => (error = describe(cause)));
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
    openCodeBrowserServers.clear();
    activeBinary = info.binaryPath;
    runtimeState = 'connected';
    runtimeError = '';
    hasConnected = true;
    if (directory)
      await ensureOpenCodeBrowser(directory).catch((cause) => (error = describe(cause)));
    await resync().catch((cause) => {
      error = describe(cause);
    });
    scheduleInboxRefresh();
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
      scheduleInboxRefresh();
      runtimeState = 'error';
      runtimeError = describe(cause);
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
      setSetting('sai-opencode-bin', candidate);
    } catch (cause) {
      runtimeError = `${describe(cause)}${runtimeState === 'connected' ? ' The current OpenCode connection remains active.' : ''}`;
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
      return;
    }
    if (!directory || planReady || setupLoading) return;
    const now = Date.now();
    if (now - lastSetupProbe < (setupProbeCount < 12 ? 5000 : 30000)) return;
    lastSetupProbe = now;
    setupProbeCount++;
    const path = directory;
    await refreshSetup(path);
    if (
      path !== directory ||
      !setup?.pluginConfigured ||
      setup.plugin.state === 'ready' ||
      setupRestarted.has(path) ||
      sending ||
      running
    )
      return;
    try {
      const active = await client.session.active();
      if (path !== directory || Object.values(active).some((session) => session.type === 'running'))
        return;
      if ((await restartSetup()) && path === directory) setupRestarted.add(path);
    } catch (cause) {
      if (path === directory) setupError = describe(cause);
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
    if (acpAgent) return;
    const saved = getSetting(`sai-session:${path}`);
    const initial = sessionID ?? saved ?? sessions[0]?.id;
    if (initial && initial !== sessionID) {
      if (!(await restoreSession(initial))) {
        if (current !== selection || path !== directory) return;
        removeSetting(`sai-session:${path}`);
        if (sessions[0]) await selectSession(sessions[0].id, true);
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
    setSetting('sai-project-catalog', JSON.stringify(next));
    scheduleInboxRefresh();
  }

  function inboxTime(key: string, observed = Date.now()) {
    if (inboxSeen[key] === undefined || observed < inboxSeen[key]) {
      inboxSeen[key] = observed;
      if (Object.keys(inboxSeen).length > maxInboxSeen) {
        const oldest = Object.entries(inboxSeen)
          .filter(([entry]) => entry !== key)
          .toSorted((left, right) => left[1] - right[1])[0];
        delete inboxSeen[oldest[0]];
      }
      setSetting('sai-inbox-seen', JSON.stringify(inboxSeen));
    }
    return inboxSeen[key];
  }

  function forgetInboxTime(key: string) {
    if (inboxSeen[key] === undefined) return;
    delete inboxSeen[key];
    setSetting('sai-inbox-seen', JSON.stringify(inboxSeen));
  }

  function scheduleInboxRefresh() {
    ++inboxGeneration;
    clearTimeout(inboxRefreshTimer);
    inboxRefreshTimer = setTimeout(() => void refreshInbox(), 150);
  }

  async function refreshInbox() {
    if (disposed) return;
    const generation = ++inboxGeneration;
    inboxLoading = true;
    const locations = inboxLocations(projectCatalog);
    const byDirectory = new Map(locations.map((location) => [location.directory, location]));
    const source = client;
    const [acpResult, ...openCodeResults] = await Promise.allSettled([
      acp.pendingInbox(),
      ...(source
        ? locations.map(async (location) => {
            const [permissions, forms] = await Promise.all([
              source.permission.request.list({ location: { directory: location.directory } }),
              source.form.list({ location: { directory: location.directory } }),
            ]);
            const ids = [
              ...new Set([...permissions.data, ...forms.data].map((item) => item.sessionID)),
            ];
            const agents = new Map(
              await Promise.all(
                ids.map(async (id) => {
                  const agent = await source.session
                    .get({ sessionID: id })
                    .then((session) => session.agent)
                    .catch(() => null);
                  return [id, agent] as const;
                }),
              ),
            );
            return { location, permissions: permissions.data, forms: forms.data, agents };
          })
        : []),
    ]);
    if (generation !== inboxGeneration || disposed) return;
    const items: InboxItem[] = [];
    if (acpResult.status === 'fulfilled') {
      for (const pending of acpResult.value) {
        const sessionId = pending.message.params?.sessionId;
        const requestId = pending.message.id;
        if (typeof sessionId !== 'string' || requestId == null) continue;
        const thread = agentThreads.find(
          (item) => item.agent === pending.agent && item.sessionId === sessionId,
        );
        if (!thread) continue;
        const location = byDirectory.get(thread.directory);
        if (!location) continue;
        const tool = pending.message.params?.toolCall;
        const title =
          tool && typeof tool === 'object' && 'title' in tool && typeof tool.title === 'string'
            ? tool.title
            : 'Allow agent action?';
        const options = Array.isArray(pending.message.params?.options)
          ? pending.message.params.options.filter(
              (option): option is NonNullable<InboxItem['options']>[number] =>
                typeof option === 'object' &&
                option !== null &&
                typeof option.optionId === 'string' &&
                typeof option.name === 'string' &&
                typeof option.kind === 'string',
            )
          : [];
        const key = `acp:${pending.agent}:${requestId}`;
        items.push({
          ...location,
          key,
          kind: 'acp-permission',
          agent: agentAvailability.find((item) => item.id === pending.agent)?.name ?? pending.agent,
          agentId: pending.agent,
          sessionId,
          requestId,
          text: title,
          receivedAt: pending.receivedAt,
          options,
        });
      }
    }
    for (const result of openCodeResults) {
      if (result.status !== 'fulfilled') continue;
      const { location, permissions, forms, agents } = result.value;
      for (const request of permissions) {
        const key = `opencode:permission:${request.id}`;
        items.push({
          ...location,
          key,
          kind: 'opencode-permission',
          agent: agents.get(request.sessionID) ?? 'OpenCode',
          sessionId: request.sessionID,
          requestId: request.id,
          text:
            request.message?.trim() ||
            `Allow ${request.action} on ${request.resources.join(', ')}?`,
          receivedAt: openCodeRequestTime(request.id) ?? inboxTime(key),
        });
      }
      for (const form of forms) {
        const key = `opencode:form:${form.id}`;
        items.push({
          ...location,
          key,
          kind: 'question',
          agent: agents.get(form.sessionID) ?? 'OpenCode',
          sessionId: form.sessionID,
          requestId: form.id,
          text: [form.title, ...form.fields.map((field) => field.title ?? field.key)].join(' · '),
          receivedAt: openCodeRequestTime(form.id) ?? inboxTime(key),
        });
      }
    }
    inboxItems = sortInbox(items);
    inboxError =
      !source ||
      acpResult.status === 'rejected' ||
      openCodeResults.some((result) => result.status === 'rejected')
        ? 'Some projects could not be checked.'
        : '';
    inboxLoading = false;
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
    agent: string | null,
  ) {
    const created = await invoke<{ path: string; branch: string; base: string; setup: string }>(
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
    const startAgent = () => {
      if (directory !== created.path) return;
      if (agent === 'opencode') {
        if (workReady) newWork();
        else error = 'Complete OpenCode setup in this worktree before starting an agent.';
      } else if (agent) {
        openAgent(agent);
      }
    };
    if (created.setup) {
      const paneId = splitFocusedPane('row', 'terminal', created.setup);
      if (!paneId) return;
      terminalExitWaiters.set(paneId, (code) => {
        if (code === 0) startAgent();
        else if (code >= 0) error = `Worktree setup exited with code ${code}.`;
      });
      return;
    }
    startAgent();
  }

  async function deleteProjectWorktree(repository: string, path: string, branch: string) {
    let config: WorktreeConfig | null;
    try {
      config = await invoke<WorktreeConfig | null>('worktree_config', { worktree: path });
    } catch (cause) {
      error = describe(cause);
      return;
    }
    const e2eAnswer =
      import.meta.env.MODE === 'e2e' ? sessionStorage.getItem('sai-e2e-delete-worktree') : null;
    if (e2eAnswer) sessionStorage.removeItem('sai-e2e-delete-worktree');
    const confirmed =
      e2eAnswer === 'Yes'
        ? true
        : e2eAnswer === 'No'
          ? false
          : await ask(
              config
                ? `Delete worktree “${branch}” at ${path}? This removes uncommitted and ignored files, including copied files. The branch will remain.`
                : `Delete worktree “${branch}” at ${path}? Uncommitted and ignored files block deletion. The branch will remain.`,
              { title: 'Delete worktree', kind: 'warning' },
            );
    if (!confirmed) return;
    const wasSelected = directory === path;
    try {
      if (config?.archive) {
        if (!wasSelected) await loadProject(path);
        const paneId = splitFocusedPane('row', 'terminal', config.archive);
        if (!paneId) return;
        const code = await new Promise<number>((resolve) =>
          terminalExitWaiters.set(paneId, resolve),
        );
        if (code < 0) return;
        if (code !== 0) {
          const deleteAnyway = await ask(
            `Archive script exited with code ${code}. Delete “${branch}” anyway?`,
            { title: 'Archive failed', kind: 'warning' },
          );
          if (!deleteAnyway) return;
        }
      }
      if (directory === path) await loadProject(repository);
      await Promise.all(
        leaves(paneLayouts[path] ?? mainPane())
          .filter((pane) => pane.kind === 'terminal')
          .map((pane) => invoke('terminal_close', { id: pane.id })),
      );
      await invoke('delete_worktree', { repository, worktree: path, force: !!config });
      saveProjectCatalog(removeWorktree(projectCatalog, repository, path));
      const removedThreads = agentThreads.filter((thread) => thread.directory === path);
      agentThreads = agentThreads.filter((thread) => thread.directory !== path);
      saveAgentThreads(agentThreads);
      forgetMissingRecentThreads();
      for (const thread of removedThreads) forgetThreadAttention(thread);
      delete paneLayouts[path];
      persistPaneLayouts();
      removeSetting(`sai-session:${path}`);
    } catch (cause) {
      if (directory !== path) await loadProject(path);
      error = describe(cause);
    }
  }

  async function createProjectPullRequest(
    repository: string,
    worktree: ProjectWorktree,
    base: string,
    title: string,
    body: string,
    isDraft: boolean,
  ) {
    const pullRequest = await invoke<{ number: number; url: string }>('create_pull_request', {
      repository,
      worktree: worktree.path,
      branch: worktree.branch,
      base,
      title,
      body,
      draft: isDraft,
    });
    saveProjectCatalog(
      setWorktreePullRequest(projectCatalog, repository, worktree.path, pullRequest),
    );
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

  async function loadProject(path: string, recordRestoredThread = true) {
    if (directory !== path) {
      for (const batch of Object.values(pendingAgentBatches))
        completeAgentBatch(batch.id, 'Project changed before comments were sent.');
      for (const resolve of terminalExitWaiters.values()) resolve(-1);
      terminalExitWaiters.clear();
    }
    ++projectLoadGeneration;
    saveViewState();
    error = '';
    const current = ++selection;
    directory = path;
    browserAccessDisabled = getSetting(`sai-browser-disabled:${path}`) === 'true';
    focusedPane = leaves(paneLayouts[path] ?? mainPane())[0]?.id ?? 'main';
    setSetting('sai-directory', path);
    lastSetupProbe = 0;
    setupProbeCount = 0;
    const savedMain = leaves(paneLayouts[path] ?? mainPane()).find((leaf) => leaf.id === 'main');
    acpAgent = savedMain?.agent ?? null;
    acpThread = savedMain?.thread ?? null;
    const restoredThread = leaves(paneLayouts[path] ?? mainPane()).find(
      (leaf) => leaf.id === focusedPane,
    )?.thread;
    if (
      recordRestoredThread &&
      restoredThread &&
      agentThreads.some((thread) => threadKey(thread) === threadKey(restoredThread))
    ) {
      rememberRecentThread(restoredThread);
      if (document.hasFocus()) markThreadRead(restoredThread);
    }
    ++sessionRefresh;
    workReady = false;
    planReady = false;
    setup = null;
    selectedAgentID = '';
    selectedModelKey = '';
    clearDraftAttachments();
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
    if (client) await ensureOpenCodeBrowser(path).catch((cause) => (error = describe(cause)));
    if (!client || !(await refreshSetup(path)) || current !== selection) return;
    draft = viewStates.get(viewKey())?.draft ?? '';
    if (acpAgent) return;
    if (!workReady && !planReady) return;
    try {
      await refreshSessions();
      if (current !== selection) return;
      const saved = getSetting(`sai-session:${directory}`);
      if (saved && (await restoreSession(saved))) return;
      if (current !== selection) return;
      if (saved) removeSetting(`sai-session:${directory}`);
      if (sessions[0]) await selectSession(sessions[0].id, true);
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
        if (paneLayouts[path]) {
          paneLayouts = {
            ...paneLayouts,
            [report.repository]: migratePaneDirectory(paneLayouts[path], path, report.repository),
          };
          delete paneLayouts[path];
          persistPaneLayouts();
        }
        saveProjectCatalog(replaceRepositoryPath(projectCatalog, path, report.repository));
        if (recentCycleKeys) {
          const selectedKey = recentCycleKeys[recentCycleIndex];
          const migratedSelected = selectedKey
            ? migrateRecentThreadKeys([selectedKey], agentThreads, path, report.repository)[0]
            : null;
          recentCycleKeys = migrateRecentThreadKeys(
            recentCycleKeys,
            agentThreads,
            path,
            report.repository,
          );
          recentCycleIndex = migratedSelected ? recentCycleKeys.indexOf(migratedSelected) : -1;
        }
        recentThreadKeys = migrateRecentThreadKeys(
          recentThreadKeys,
          agentThreads,
          path,
          report.repository,
        );
        setSetting('sai-recent-agent-threads', JSON.stringify(recentThreadKeys));
        const attentionKeys = new Map(
          agentThreads
            .filter((thread) => thread.directory === path)
            .map((thread) => [
              threadKey(thread),
              threadKey({ ...thread, directory: report.repository }),
            ]),
        );
        threadAttention = Object.fromEntries(
          Object.entries(threadAttention).map(([key, value]) => [
            attentionKeys.get(key) ?? key,
            value,
          ]),
        );
        saveThreadAttention();
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
      setSetting('sai-directory', report.repository);
      setup = report;
      workReady = report.workReady;
      planReady = report.planReady;
      if (!selectedAgentID || !report.agents.some((agent) => agent.id === selectedAgentID))
        selectedAgentID =
          report.agents.find((agent) => agent.id !== 'architect')?.id ?? report.agents[0]?.id ?? '';
      if (!selectedModelKey || !report.models.some((model) => modelKey(model) === selectedModelKey))
        selectedModelKey = report.defaultModel ? modelKey(report.defaultModel) : '';
      return true;
    } catch (cause) {
      if (current !== selection) return false;
      setupError = describe(cause);
      workReady = false;
      planReady = false;
      return false;
    } finally {
      if (current === selection) setupLoading = false;
    }
  }

  async function restartSetup() {
    if (connecting || !client) return false;
    connecting = true;
    setupLoading = true;
    setupError = '';
    clearTimeout(recoveryTimer);
    try {
      const active = await client.session.active();
      if (sending || Object.values(active).some((session) => session.type === 'running')) {
        setupError = 'Wait for active OpenCode sessions to finish before restarting.';
        return false;
      }
      const info = await invoke<RuntimeInfo>('start_runtime', {
        binaryPath: appliedBinaryPath || null,
        restart: true,
      });
      await activateRuntime(info);
      return true;
    } catch (cause) {
      setupError = describe(cause);
      return false;
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
      await selectSession(id, true);
      return true;
    } catch (cause) {
      if (isSessionNotFoundError(cause)) return false;
      throw cause;
    }
  }

  function clearSelectedSession() {
    saveViewState();
    sessionID = null;
    if (mobileView === 'details') mobileView = 'chat';
    selectedSession = null;
    resetTimeline();
    snapshot = { plan: null, questions: null };
    clearDraftAttachments();
    running = false;
    pendingPermissions = [];
    pendingForms = [];
    removeSetting(`sai-session:${directory}`);
  }

  function openAgent(agent: AgentId, thread: AgentThread | null = null, preserveCycle = false) {
    if (!directory) return;
    if (!preserveCycle) {
      recentCycleKeys = null;
      ++recentJumpGeneration;
    }
    if (thread) {
      rememberRecentThread(thread);
      markThreadRead(thread);
    }
    if (focusedPane !== 'main' && leaves(paneLayout).some((leaf) => leaf.id === focusedPane)) {
      savePaneLayout(updatePane(paneLayout, focusedPane, { agent, thread }));
      return;
    }
    saveViewState();
    acpAgent = agent;
    acpThread = thread;
    savePaneLayout(updatePane(paneLayout, 'main', { agent, thread }));
    mobileView = 'chat';
  }

  function openCommandPalette() {
    if (paletteDialog.open || document.querySelector('dialog[open]')) return;
    ++recentJumpGeneration;
    palettePreviousFocus = document.activeElement as HTMLElement | null;
    restorePaletteFocus = true;
    paletteQuery = '';
    paletteIndex = 0;
    paletteDialog.showModal();
    void tick().then(() => paletteInput.focus());
  }

  function closeCommandPalette(restore = true) {
    restorePaletteFocus = restore;
    paletteDialog.close();
  }

  function commandPaletteClosed() {
    if (restorePaletteFocus) palettePreviousFocus?.focus();
    palettePreviousFocus = null;
  }

  function saveCommands(commands: SavedCommand[]) {
    savedCommands = commands;
    setSetting('sai-saved-commands', JSON.stringify(commands));
  }

  function openCommandsDialog() {
    commandName = '';
    commandText = '';
    commandScope = 'global';
    editingCommand = null;
    commandsDialog.showModal();
  }

  function saveCommand() {
    const name = commandName.trim();
    const script = commandText.trim();
    const project =
      commandScope === 'project' ? selectedRepository(projectCatalog, directory) : null;
    if (!name || !script || (commandScope === 'project' && !project)) return;
    const entry: SavedCommand = {
      id: editingCommand ?? crypto.randomUUID(),
      name,
      command: script,
      project,
    };
    saveCommands(
      editingCommand
        ? savedCommands.map((item) => (item.id === editingCommand ? entry : item))
        : [...savedCommands, entry],
    );
    commandName = '';
    commandText = '';
    commandScope = 'global';
    editingCommand = null;
  }

  function runSavedCommand(command: SavedCommand) {
    if (!directory) {
      error = 'Select a project or worktree before running a command.';
      return;
    }
    closeCommandPalette(false);
    splitFocusedPane('row', 'terminal', command.command);
  }

  async function openAgentTerminal(id: string) {
    const terminal = agentTerminals.find((item) => item.terminalId === id);
    agentTerminalsDialog?.close();
    if (terminal && terminal.directory !== directory) await loadProject(terminal.directory, false);
    splitFocusedPane('row', 'agent-terminal', undefined, id);
  }

  async function choosePaletteEntry(entry: PaletteEntry | null) {
    if (entry?.kind === 'command' && entry.command) {
      runSavedCommand(entry.command);
      return;
    }
    const target = entry?.directory ?? directory;
    const thread =
      entry?.kind === 'thread'
        ? entry.thread
        : entry?.kind === 'location'
          ? newestAvailableThread(agentThreads, agentAvailability, target, entry.agent)
          : null;
    const agent =
      entry?.agent ?? thread?.agent ?? agentAvailability.find((item) => item.available)?.id;
    if (!target || !agent) {
      error = 'Choose a project and install an agent to start a thread.';
      return;
    }
    if (!agentAvailability.some((item) => item.id === agent && item.available)) {
      error = `${agent} is unavailable. Choose another agent.`;
      return;
    }
    closeCommandPalette(false);
    let expectedProjectLoad = projectLoadGeneration;
    if (target !== directory) {
      const pending = loadProject(target, false);
      expectedProjectLoad = projectLoadGeneration;
      await pending;
    }
    if (expectedProjectLoad !== projectLoadGeneration || !directory) return;
    const selectedThread = thread
      ? (agentThreads.find(
          (item) =>
            item.directory === directory &&
            item.agent === thread.agent &&
            item.sessionId === thread.sessionId,
        ) ?? null)
      : null;
    focusMainPane();
    openAgent(agent, selectedThread);
    focusPaneForTyping('main');
  }

  function keydownCommandPalette(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCommandPalette();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!paletteEntries.length) return;
      paletteIndex =
        (paletteIndex + (event.key === 'ArrowDown' ? 1 : -1) + paletteEntries.length) %
        paletteEntries.length;
      scrollToActivePaletteEntry();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void choosePaletteEntry(paletteEntries[paletteIndex] ?? null);
    }
  }

  function scrollToActivePaletteEntry() {
    void tick().then(() =>
      paletteDialog
        .querySelector<HTMLElement>('.palette-entry.active')
        ?.scrollIntoView({ block: 'nearest' }),
    );
  }

  function saveAgentThread(thread: AgentThread) {
    agentThreads = [
      thread,
      ...agentThreads.filter(
        (item) =>
          item.agent !== thread.agent ||
          item.directory !== thread.directory ||
          item.sessionId !== thread.sessionId,
      ),
    ].toSorted((a, b) => b.updated - a.updated);
    saveAgentThreads(agentThreads);
    for (const [path, layout] of Object.entries(paneLayouts)) {
      let next = layout;
      for (const leaf of leaves(layout)) {
        if (
          leaf.thread?.sessionId === thread.sessionId &&
          leaf.thread.directory === thread.directory &&
          leaf.agent === thread.agent
        ) {
          next = updatePane(next, leaf.id, { thread });
        }
      }
      paneLayouts[path] = next;
    }
    persistPaneLayouts();
    if (
      acpAgent === thread.agent &&
      acpThread?.sessionId === thread.sessionId &&
      acpThread.directory === thread.directory
    )
      acpThread = thread;
  }

  function rememberRecentThread(thread: AgentThread) {
    recentThreadKeys = touchRecentThread(recentThreadKeys, thread);
    setSetting('sai-recent-agent-threads', JSON.stringify(recentThreadKeys));
  }

  function forgetMissingRecentThreads() {
    recentThreadKeys = retainRecentThreads(recentThreadKeys, agentThreads);
    setSetting('sai-recent-agent-threads', JSON.stringify(recentThreadKeys));
  }

  function availableRecentKeys(): string[] {
    const availableAgents = new Set(
      agentAvailability.filter((agent) => agent.available).map((agent) => agent.id),
    );
    const projectPaths = new Set([
      ...projectCatalog.repositories,
      ...Object.values(projectCatalog.worktrees).flatMap((worktrees) =>
        worktrees.map((worktree) => worktree.path),
      ),
    ]);
    const availableThreads = new Set(
      agentThreads
        .filter((thread) => availableAgents.has(thread.agent) && projectPaths.has(thread.directory))
        .map(threadKey),
    );
    return recentThreadKeys.filter((key) => availableThreads.has(key));
  }

  function focusedThreadKey(): string | null {
    const thread =
      focusedPane === 'main'
        ? acpThread
        : leaves(paneLayout).find((pane) => pane.id === focusedPane)?.thread;
    return thread ? threadKey(thread) : null;
  }

  async function jumpToRecentThread(key: string) {
    const thread = agentThreads.find((item) => threadKey(item) === key);
    if (!thread || !agentAvailability.some((agent) => agent.id === thread.agent && agent.available))
      return;
    const jump = ++recentJumpGeneration;
    let expectedProjectLoad = projectLoadGeneration;
    const target = await invoke<string>('validate_repository', { path: thread.directory }).catch(
      () => null,
    );
    if (!target || jump !== recentJumpGeneration || expectedProjectLoad !== projectLoadGeneration)
      return;
    if (thread.directory !== directory || target !== directory) {
      const pending = loadProject(thread.directory, false);
      expectedProjectLoad = projectLoadGeneration;
      await pending;
    }
    if (jump !== recentJumpGeneration || expectedProjectLoad !== projectLoadGeneration) return;
    const selected = agentThreads.find(
      (item) =>
        item.directory === directory &&
        item.agent === thread.agent &&
        item.sessionId === thread.sessionId,
    );
    if (!selected) return;
    focusMainPane();
    openAgent(selected.agent, selected, true);
    focusPaneForTyping('main');
  }

  function openInbox() {
    if (!inboxDialog.open) inboxDialog.showModal();
    scheduleInboxRefresh();
  }

  async function focusInboxRequest(item: InboxItem, attempts = 40): Promise<void> {
    await tick();
    const request = [...document.querySelectorAll<HTMLElement>('[data-request-id]')].find(
      (element) =>
        element.dataset.requestId === String(item.requestId) &&
        element.dataset.sessionId === item.sessionId &&
        (item.kind !== 'acp-permission' || element.dataset.agentId === item.agentId) &&
        element.getClientRects().length,
    );
    if (request) {
      request.scrollIntoView({ block: 'center' });
      request.focus();
      return;
    }
    if (attempts === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return focusInboxRequest(item, attempts - 1);
  }

  async function openInboxItem(item: InboxItem) {
    inboxDialog.close();
    if (item.kind === 'acp-permission') {
      const thread = agentThreads.find(
        (entry) =>
          entry.agent === item.agentId &&
          entry.sessionId === item.sessionId &&
          entry.directory === item.directory,
      );
      if (thread) await jumpToRecentThread(threadKey(thread));
    } else {
      if (directory !== item.directory) await loadProject(item.directory, false);
      if (directory === item.directory) await selectSession(item.sessionId);
    }
    await focusInboxRequest(item);
  }

  async function decideInbox(item: InboxItem, optionId: string | null) {
    if (item.kind === 'acp-permission') {
      const thread = agentThreads.find(
        (entry) =>
          entry.agent === item.agentId &&
          entry.sessionId === item.sessionId &&
          entry.directory === item.directory,
      );
      if (!thread) throw new Error('Thread is no longer available.');
      await acp.permission(thread.agent, item.requestId, optionId);
    } else if (item.kind === 'opencode-permission') {
      if (!client) throw new Error('OpenCode is not connected.');
      try {
        await client.permission.get({
          sessionID: item.sessionId,
          requestID: String(item.requestId),
        });
        await client.permission.reply({
          sessionID: item.sessionId,
          requestID: String(item.requestId),
          decision: optionId === 'reject' ? 'reject' : 'once',
        });
      } catch (cause) {
        if (!isPermissionNotFoundError(cause)) throw cause;
      }
    }
    await refreshInbox();
    if (item.kind === 'acp-permission') void restoreAgentActivity();
    if (item.kind === 'opencode-permission' && item.sessionId === sessionID) void refreshPrompts();
  }

  function createAgentThread(thread: AgentThread) {
    saveAgentThread(thread);
    rememberRecentThread(thread);
    if (acpAgent === thread.agent && directory === thread.directory && !acpThread) {
      migrateDiffComments(
        diffCommentKey('main'),
        `${directory}\0main\0acp:${thread.agent}:${thread.sessionId}`,
      );
      acpThread = thread;
      savePaneLayout(updatePane(paneLayout, 'main', { agent: thread.agent, thread }));
    }
  }

  function persistPaneLayouts() {
    setSetting('sai-pane-layouts', JSON.stringify(paneLayouts));
  }

  function savePaneLayout(layout: Pane) {
    paneLayouts = { ...paneLayouts, [directory]: layout };
    persistPaneLayouts();
  }

  function paneSpan(id: string, axis: 'row' | 'column') {
    const bounds = document
      .querySelector<HTMLElement>(`[data-pane-id="${id}"]`)
      ?.getBoundingClientRect();
    return axis === 'row' ? bounds?.width : bounds?.height;
  }

  function splitFocusedPane(
    direction: 'row' | 'column',
    kind?: 'terminal' | 'browser' | 'agent-terminal',
    command?: string,
    agentTerminalId?: string,
  ) {
    if (!directory) return;
    let target = focusedPane;
    let splitDirection = direction;
    let span = paneSpan(target, splitDirection);
    if ((command || agentTerminalId) && (!span || span < 2 * minPaneSpan + 8)) {
      const options = leaves(paneLayout).flatMap((pane) =>
        (['row', 'column'] as const).map((axis) => ({
          id: pane.id,
          axis,
          span: paneSpan(pane.id, axis) ?? 0,
        })),
      );
      const choice = options
        .filter((option) => option.span >= 2 * minPaneSpan + 8)
        .toSorted(
          (a, b) => Number(b.id === focusedPane) - Number(a.id === focusedPane) || b.span - a.span,
        )[0];
      if (choice) {
        target = choice.id;
        splitDirection = choice.axis;
        span = choice.span;
      }
    }
    if (!span || span < 2 * minPaneSpan + 8) {
      error =
        command || agentTerminalId
          ? 'Enlarge a pane before running this command.'
          : 'Enlarge the focused pane before splitting it again.';
      return;
    }
    ++recentJumpGeneration;
    const layout = splitPane(paneLayout, target, splitDirection);
    const old = new Set(leaves(paneLayout).map((leaf) => leaf.id));
    const created = leaves(layout).find((leaf) => !old.has(leaf.id));
    if (!created) return;
    if (command) pendingCommands = { ...pendingCommands, [created.id]: command };
    const browserTab = kind === 'browser' ? newBrowserTab() : null;
    savePaneLayout(
      browserTab
        ? updatePane(layout, created.id, {
            kind: 'browser',
            tabs: [browserTab],
            activeTab: browserTab.id,
          })
        : kind === 'agent-terminal'
          ? updatePane(layout, created.id, { kind, terminalId: agentTerminalId })
          : kind
            ? updatePane(layout, created.id, { kind })
            : layout,
    );
    focusPaneForTyping(created.id);
    return created.id;
  }

  function focusPaneForTyping(id: string) {
    focusedPane = id;
    const thread =
      id === 'main' ? acpThread : leaves(paneLayout).find((pane) => pane.id === id)?.thread;
    if (thread) {
      rememberRecentThread(thread);
      markThreadRead(thread);
    }
    promptFocusPane = id;
    void focusPanePromptAfterTick(id);
  }

  function attachPickedElement(browserId: string, attachment: BrowserAttachment) {
    const candidates = leaves(paneLayout).filter(
      (leaf) => leaf.id !== browserId && (leaf.id === 'main' || !!leaf.agent),
    );
    const source = document.querySelector<HTMLElement>(`[data-pane-id="${browserId}"]`);
    if (!source || !candidates.length)
      throw new Error('Open an agent pane next to the browser first.');
    const bounds = source.getBoundingClientRect();
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    const next = candidates
      .map((leaf) => {
        const element = document.querySelector<HTMLElement>(`[data-pane-id="${leaf.id}"]`);
        const rect = element?.getBoundingClientRect();
        return {
          id: leaf.id,
          distance: rect
            ? Math.hypot(
                (rect.left + rect.right) / 2 - centerX,
                (rect.top + rect.bottom) / 2 - centerY,
              )
            : Infinity,
        };
      })
      .toSorted((a, b) => a.distance - b.distance)[0];
    if (!next || !Number.isFinite(next.distance)) throw new Error('Agent pane is unavailable.');
    if (next.id === 'main' && !acpAgent) {
      draft = [draft.trim(), attachment.text].filter(Boolean).join('\n\n');
      attachedFiles = [...attachedFiles, attachment.imagePath];
      pickedImageText.set(attachment.imagePath, attachment.text);
    } else {
      pickedAttachments = { ...pickedAttachments, [next.id]: attachment };
    }
    focusPaneForTyping(next.id);
  }

  function removeAttachedFile(path: string) {
    attachedFiles = attachedFiles.filter((item) => item !== path);
    const pickedText = pickedImageText.get(path);
    if (pickedText) {
      draft = draft.replace(pickedText, '').trim();
      pickedImageText.delete(path);
      void invoke('browser_remove_capture', { path });
    }
  }

  function clearDraftAttachments() {
    draft = draftWithoutPickedImages(draft);
    for (const path of attachedFiles) {
      if (inFlightCaptures.has(path)) continue;
      if (!pickedImageText.delete(path)) continue;
      void invoke('browser_remove_capture', { path });
    }
    attachedFiles = [];
  }

  function draftWithoutPickedImages(value: string) {
    for (const path of attachedFiles) {
      const pickedText = pickedImageText.get(path);
      if (pickedText) value = value.replace(pickedText, '').trim();
    }
    return value;
  }

  function markPickConsumed(id: string) {
    pickedAttachments = Object.fromEntries(
      Object.entries(pickedAttachments).filter(([, attachment]) => attachment.id !== id),
    );
  }

  function focusPane(id: string) {
    if (focusedPane === id) return;
    ++recentJumpGeneration;
    focusedPane = id;
    const thread =
      id === 'main' ? acpThread : leaves(paneLayout).find((pane) => pane.id === id)?.thread;
    if (thread) {
      rememberRecentThread(thread);
      markThreadRead(thread);
    }
  }

  async function focusPanePromptAfterTick(id: string) {
    await tick();
    if (focusedPane !== id || promptFocusPane !== id) return;
    const pane = document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
    const prompt = pane?.querySelector<HTMLTextAreaElement>(
      '[data-pane-prompt]:not(:disabled), .xterm-helper-textarea, .browser-toolbar input',
    );
    const picker = pane?.querySelector<HTMLButtonElement>(
      '[data-agent-choice]:not(:disabled), [data-pane-picker]',
    );
    if (prompt) {
      prompt.focus();
      promptFocusPane = null;
    } else if (picker) {
      picker.focus();
      promptFocusPane = null;
    } else {
      pane?.focus();
      if (id === 'main' && !acpAgent) promptFocusPane = null;
    }
  }

  function cancelPendingPromptFocus(event: FocusEvent) {
    if (!promptFocusPane) return;
    const pane = document.querySelector<HTMLElement>(`[data-pane-id="${promptFocusPane}"]`);
    if (!(event.target instanceof Node) || !pane?.contains(event.target)) promptFocusPane = null;
  }

  function closeFocusedPane(id: string) {
    const batch = pendingAgentBatches[id];
    if (batch) completeAgentBatch(batch.id, 'Agent pane closed before comments were sent.');
    ++recentJumpGeneration;
    terminalExitWaiters.get(id)?.(1);
    terminalExitWaiters.delete(id);
    if (leaves(paneLayout).find((leaf) => leaf.id === id)?.kind === 'terminal')
      void invoke('terminal_close', { id });
    let layout = closePane(paneLayout, id);
    if (!('direction' in layout) && layout.id === 'main')
      layout = { id: 'main', agent: acpAgent, thread: acpThread };
    savePaneLayout(layout);
    changesPanes = changesPanes.filter((item) => item !== id);
    focusPaneForTyping(leaves(layout)[0]?.id ?? 'main');
  }

  function closeCurrentPane() {
    ++recentJumpGeneration;
    if (leaves(paneLayout).length > 1) {
      closeFocusedPane(focusedPane);
      return;
    }
    if (acpAgent || !leaves(paneLayout).some((pane) => pane.id === 'main')) {
      if (leaves(paneLayout)[0]?.kind === 'terminal')
        void invoke('terminal_close', { id: leaves(paneLayout)[0].id });
      acpAgent = null;
      acpThread = null;
      savePaneLayout(mainPane());
      changesPanes = [];
    } else if (sessionID) {
      clearSelectedSession();
    }
    focusPaneForTyping('main');
  }

  function updatePaneRatio(id: string, ratio: number) {
    savePaneLayout(updatePane(paneLayout, id, { ratio }));
  }

  function createPaneThread(id: string, thread: AgentThread) {
    migrateDiffComments(
      diffCommentKey(id),
      `${directory}\0${id}\0acp:${thread.agent}:${thread.sessionId}`,
    );
    savePaneLayout(updatePane(paneLayout, id, { thread }));
    saveAgentThread(thread);
    rememberRecentThread(thread);
  }

  function choosePaneAgent(id: string, agent: AgentId) {
    const batch = pendingAgentBatches[id];
    if (batch) completeAgentBatch(batch.id, 'Agent pane changed before comments were sent.');
    savePaneLayout(updatePane(paneLayout, id, { agent, thread: null, kind: undefined }));
    focusPaneForTyping(id);
  }

  function choosePaneTerminal(id: string) {
    const batch = pendingAgentBatches[id];
    if (batch) completeAgentBatch(batch.id, 'Agent pane changed before comments were sent.');
    savePaneLayout(updatePane(paneLayout, id, { agent: null, thread: null, kind: 'terminal' }));
    focusPaneForTyping(id);
  }

  function choosePaneBrowser(id: string) {
    const batch = pendingAgentBatches[id];
    if (batch) completeAgentBatch(batch.id, 'Agent pane changed before comments were sent.');
    const tab = newBrowserTab();
    savePaneLayout(
      updatePane(paneLayout, id, {
        agent: null,
        thread: null,
        kind: 'browser',
        tabs: [tab],
        activeTab: tab.id,
      }),
    );
    focusPaneForTyping(id);
  }

  function updatePaneBrowser(id: string, tabs: BrowserTab[], activeTab: string) {
    savePaneLayout(updatePane(paneLayout, id, { tabs, activeTab }));
  }

  function diffCommentKey(id: string) {
    if (id === 'main')
      return `${directory}\0main\0${acpAgent ? `acp:${acpAgent}:${acpThread?.sessionId ?? 'new'}` : `opencode:${sessionID ?? 'new'}`}`;
    const pane = leaves(paneLayout).find((leaf) => leaf.id === id);
    return `${directory}\0${id}\0acp:${pane?.agent ?? 'none'}:${pane?.thread?.sessionId ?? 'new'}`;
  }

  function updateDiffComments(scope: string, comments: DiffComment[]) {
    diffComments = { ...diffComments, [scope]: comments };
  }

  function migrateDiffComments(from: string, to: string) {
    if (from === to || !diffComments[from]?.length) return;
    const next = { ...diffComments, [to]: [...(diffComments[to] ?? []), ...diffComments[from]] };
    delete next[from];
    diffComments = next;
  }

  function removeSentDiffComments(scope: string, ids: string[]) {
    const sent = new Set(ids);
    diffComments = Object.fromEntries(
      Object.entries(diffComments).map(([key, comments]) => [
        key,
        key === scope || comments.some((comment) => sent.has(comment.id))
          ? comments.filter((comment) => !sent.has(comment.id))
          : comments,
      ]),
    );
  }

  function completeAgentBatch(id: string, failure: string | null) {
    const entry = Object.entries(pendingAgentBatches).find(([, batch]) => batch.id === id);
    if (entry) {
      const next = { ...pendingAgentBatches };
      delete next[entry[0]];
      pendingAgentBatches = next;
    }
    const waiter = batchWaiters.get(id);
    batchWaiters.delete(id);
    if (failure) waiter?.reject(new Error(failure));
    else waiter?.resolve();
  }

  async function sendDiffComments(id: string, scope: string, text: string): Promise<void> {
    if (scope !== diffCommentKey(id))
      throw new Error('The agent thread changed. Review these comments before sending.');
    if (id === 'main' && !acpAgent) {
      if (!client || !sessionID || running || sending)
        throw new Error('Wait for the current agent turn.');
      const current = selection;
      const session = sessionID;
      sending = true;
      running = true;
      activity = 'Thinking';
      try {
        await client.session.prompt({ sessionID: session, text });
        if (current === selection && session === sessionID)
          void refreshSession(session).catch((cause) => (error = describe(cause)));
      } catch (cause) {
        if (current === selection && session === sessionID) running = false;
        throw cause;
      } finally {
        sending = false;
      }
      return;
    }
    const agent =
      id === 'main' ? acpAgent : leaves(paneLayout).find((leaf) => leaf.id === id)?.agent;
    if (!agent || pendingAgentBatches[id]) throw new Error('Agent pane is not ready for comments.');
    const batch = { id: crypto.randomUUID(), text };
    return new Promise<void>((resolve, reject) => {
      batchWaiters.set(batch.id, { resolve, reject });
      pendingAgentBatches = { ...pendingAgentBatches, [id]: batch };
    });
  }

  function focusMainPane() {
    if (!leaves(paneLayout).some((leaf) => leaf.id === 'main')) {
      savePaneLayout({
        id: crypto.randomUUID(),
        direction: 'row',
        ratio: 0.5,
        first: mainPane(),
        second: paneLayout,
      });
    }
    focusedPane = 'main';
  }

  function removeAgentThread(thread: AgentThread) {
    agentThreads = agentThreads.filter(
      (item) =>
        item.agent !== thread.agent ||
        item.directory !== thread.directory ||
        item.sessionId !== thread.sessionId,
    );
    saveAgentThreads(agentThreads);
    forgetMissingRecentThreads();
    forgetThreadAttention(thread);
    for (const [path, layout] of Object.entries(paneLayouts)) {
      let next = layout;
      for (const leaf of leaves(layout)) {
        if (
          leaf.thread?.sessionId === thread.sessionId &&
          leaf.thread.directory === thread.directory &&
          leaf.agent === thread.agent
        )
          next = updatePane(next, leaf.id, { thread: null });
      }
      paneLayouts[path] = next;
    }
    persistPaneLayouts();
    if (
      acpThread?.sessionId === thread.sessionId &&
      acpThread.directory === thread.directory &&
      acpAgent === thread.agent
    ) {
      acpThread = null;
      savePaneLayout(updatePane(paneLayout, 'main', { agent: thread.agent, thread: null }));
    }
  }

  function agentThreadKey(thread: AgentThread): string {
    return threadKey(thread);
  }

  function saveThreadAttention() {
    setSetting('sai-thread-attention', JSON.stringify(threadAttention));
  }

  function markThreadRead(thread: AgentThread) {
    const next = markAttentionRead(threadAttention, threadKey(thread));
    if (next === threadAttention) return;
    threadAttention = next;
    attentionRevision++;
    saveThreadAttention();
  }

  function forgetThreadAttention(thread: AgentThread) {
    const key = threadKey(thread);
    const next = { ...threadAttention };
    delete next[key];
    threadAttention = next;
    saveThreadAttention();
    const nextRunning = { ...runningAgentThreads };
    delete nextRunning[key];
    runningAgentThreads = nextRunning;
    updateAttentionBadge();
  }

  function threadIsViewed(key: string): boolean {
    return (
      document.hasFocus() &&
      leaves(paneLayout).some((pane) => pane.thread && threadKey(pane.thread) === key)
    );
  }

  function updateAttentionBadge() {
    if (!isTauri()) return;
    const threads = new Set(agentThreads.map(threadKey));
    const count = Object.entries(threadAttention).filter(
      ([key, item]) => threads.has(key) && item.status === 'waiting',
    ).length;
    void invoke('set_attention_badge', { count }).catch(() => undefined);
  }

  async function restoreAgentActivity(attempt = 0) {
    const revision = attentionRevision;
    try {
      const backendActivity = await acp.activity();
      if (disposed) return;
      if (revision !== attentionRevision) {
        if (attempt < 2) await restoreAgentActivity(attempt + 1);
        return;
      }
      const previousAttention = threadAttention;
      threadAttention = reconcileAttention(
        threadAttention,
        agentThreads.map((thread) => ({
          agent: thread.agent,
          sessionId: thread.sessionId,
          key: threadKey(thread),
          viewed: threadIsViewed(threadKey(thread)),
        })),
        backendActivity,
      );
      saveThreadAttention();
      runningAgentThreads = Object.fromEntries(
        Object.entries(threadAttention)
          .filter(([, item]) => item.status === 'working' || item.status === 'waiting')
          .map(([key]) => [key, true]),
      );
      updateAttentionBadge();
      for (const thread of agentThreads) {
        const key = threadKey(thread);
        const before = previousAttention[key];
        const after = threadAttention[key];
        if (
          after?.unread &&
          before?.status !== after.status &&
          (after.status === 'waiting' || after.status === 'done')
        )
          showThreadAttentionNotification(thread, after.status);
      }
    } catch {
      return;
    }
  }

  function updateAgentThreadStatus(thread: AgentThread, status: ThreadStatus, notifyOnDone = true) {
    const key = agentThreadKey(thread);
    if (!agentThreads.some((item) => threadKey(item) === key)) return;
    const { next, notify } = updateAttention(
      threadAttention,
      key,
      status,
      threadIsViewed(key),
      notifyOnDone,
    );
    threadAttention = next;
    attentionRevision++;
    saveThreadAttention();
    if (status === 'working' || status === 'waiting')
      runningAgentThreads = { ...runningAgentThreads, [key]: true };
    else {
      const nextRunning = { ...runningAgentThreads };
      delete nextRunning[key];
      runningAgentThreads = nextRunning;
    }
    updateAttentionBadge();
    if (notify) showThreadAttentionNotification(thread, status);
  }

  function showThreadAttentionNotification(thread: AgentThread, status: ThreadStatus) {
    if (!notificationsEnabled || !isTauri()) return;
    void invoke('show_attention_notification', {
      threadKey: threadKey(thread),
      title: thread.title,
      body: status === 'waiting' ? 'Needs your input' : 'Finished',
      sound: notificationSound,
    }).catch(() => undefined);
  }

  function handleAgentEvent(event: AgentEvent) {
    if (
      event.message.method === 'session/request_permission' ||
      event.message.method === 'sail/permission_resolved' ||
      event.message.method === 'sail/disconnected'
    )
      scheduleInboxRefresh();
    if (event.message.method === 'sail/prompt_finished') {
      const sessionId = event.message.params?.sessionId;
      const status = event.message.params?.status;
      if (typeof sessionId !== 'string' || (status !== 'done' && status !== 'failed')) return;
      for (const thread of agentThreads.filter(
        (item) => item.agent === event.agent && item.sessionId === sessionId,
      ))
        updateAgentThreadStatus(thread, status, event.message.params?.notify !== false);
    } else if (event.message.method === 'session/request_permission') {
      const sessionId = event.message.params?.sessionId;
      if (typeof sessionId !== 'string') return;
      for (const thread of agentThreads.filter(
        (item) => item.agent === event.agent && item.sessionId === sessionId,
      ))
        updateAgentThreadStatus(thread, 'waiting');
    } else if (event.message.method === 'sail/disconnected') {
      for (const thread of agentThreads.filter(
        (item) =>
          item.agent === event.agent &&
          ['working', 'waiting'].includes(threadAttention[threadKey(item)]?.status ?? ''),
      ))
        updateAgentThreadStatus(thread, 'failed');
    }
  }

  async function selectSession(id: string, automatic = false) {
    if (!client || !directory) return;
    focusMainPane();
    acpAgent = null;
    acpThread = null;
    savePaneLayout(updatePane(paneLayout, 'main', { agent: null, thread: null }));
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
    clearDraftAttachments();
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
    if (!automatic) mobileView = 'chat';
    error = '';
    setSetting(`sai-session:${directory}`, id);
    await refreshSession(id, current);
    if (current === selection) {
      await restoreViewState();
      if (!automatic && window.matchMedia('(max-width: 850px)').matches) chatArea?.focus();
    }
  }

  function syncSessionChoice(session: SessionInfo) {
    if (session.agent) selectedAgentID = session.agent;
    if (session.model) selectedModelKey = modelKey(session.model);
  }

  function newWork() {
    if (!workReady || switching || sending) return;
    focusMainPane();
    acpAgent = null;
    acpThread = null;
    savePaneLayout(updatePane(paneLayout, 'main', { agent: null, thread: null }));
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
    clearDraftAttachments();
    running = false;
    draft = viewStates.get(viewKey())?.draft ?? '';
    mobileView = 'chat';
    error = '';
  }

  async function newPlan() {
    if (!client || !directory || !planReady || switching || sending) return;
    focusMainPane();
    acpAgent = null;
    acpThread = null;
    savePaneLayout(updatePane(paneLayout, 'main', { agent: null, thread: null }));
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
    if (acpAgent || !directory) return;
    const path = directory;
    const generation = ++diffRefresh;
    if (!quiet) diffLoading = true;
    try {
      const next = await invoke<WorkingDiffInfo[]>('working_tree_diff', { path });
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
        ) {
          if (event.type === 'permission.asked' && !openCodeRequestTime(event.data.id))
            inboxTime(`opencode:permission:${event.data.id}`, event.created);
          if (event.type === 'form.created' && !openCodeRequestTime(event.data.form.id))
            inboxTime(`opencode:form:${event.data.form.id}`, event.created);
          if (event.type === 'permission.replied')
            forgetInboxTime(`opencode:permission:${event.data.requestID}`);
          if (event.type === 'form.replied' || event.type === 'form.cancelled')
            forgetInboxTime(`opencode:form:${event.data.id}`);
          scheduleRefresh();
          scheduleInboxRefresh();
        }
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
    for (const file of files) {
      if (pickedImageText.has(file)) inFlightCaptures.add(file);
    }
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
          migrateDiffComments(diffCommentKey('main'), `${path}\0main\0opencode:${id}`);
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
      for (const file of files) {
        if (!pickedImageText.delete(file)) continue;
        void invoke('browser_remove_capture', { path: file });
      }
      if (current === selection && path === directory) await refreshSession(id);
    } catch (cause) {
      if (current === selection && path === directory) {
        draft = [text, draft.trim()].filter(Boolean).join('\n\n');
        attachedFiles = [...files, ...attachedFiles.filter((file) => !files.includes(file))];
        running = false;
        error = describe(cause);
      } else {
        for (const file of files) {
          if (!pickedImageText.delete(file)) continue;
          void invoke('browser_remove_capture', { path: file });
        }
      }
    } finally {
      for (const file of files) inFlightCaptures.delete(file);
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
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ',') {
      event.preventDefault();
      if (!event.repeat) void openSettings();
      return;
    }
    if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key === 'Tab' &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      if (!recentCycleKeys) {
        recentCycleKeys = availableRecentKeys();
        recentCycleIndex = nextRecentIndex(
          recentCycleKeys,
          focusedThreadKey(),
          event.shiftKey ? -1 : 1,
        );
      } else {
        recentCycleIndex = nextRecentIndex(
          recentCycleKeys,
          recentCycleKeys[recentCycleIndex] ?? null,
          event.shiftKey ? -1 : 1,
        );
      }
      const key = recentCycleKeys[recentCycleIndex];
      if (key) void jumpToRecentThread(key);
      return;
    }
    if (
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      /^[1-9]$/.test(event.key) &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      recentCycleKeys = null;
      const key = availableRecentKeys()[Number(event.key) - 1];
      if (key) void jumpToRecentThread(key);
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'k' &&
      !event.repeat
    ) {
      event.preventDefault();
      openCommandPalette();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'w'
    ) {
      event.preventDefault();
      if (!event.repeat && !document.querySelector('dialog[open]')) closeCurrentPane();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 't' &&
      !event.repeat &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      splitFocusedPane('row', 'terminal');
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key.toLowerCase() === 'd' &&
      !event.repeat &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      splitFocusedPane(event.shiftKey ? 'column' : 'row');
      return;
    }
    if (
      !event.repeat &&
      !document.querySelector('dialog[open]') &&
      ((event.key === 'F6' && !event.metaKey && !event.ctrlKey && !event.altKey) ||
        ((event.metaKey || event.ctrlKey) &&
          event.altKey &&
          !event.shiftKey &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)))
    ) {
      const panes = leaves(paneLayout);
      if (panes.length < 2) return;
      event.preventDefault();
      const next =
        event.key === 'F6'
          ? panes[
              (panes.findIndex((leaf) => leaf.id === focusedPane) +
                (event.shiftKey ? -1 : 1) +
                panes.length) %
                panes.length
            ]?.id
          : adjacentPaneId(
              [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].map((element) => {
                const { left, right, top, bottom } = element.getBoundingClientRect();
                return { id: element.dataset.paneId ?? '', left, right, top, bottom };
              }),
              focusedPane,
              event.key.slice(5).toLowerCase() as 'left' | 'right' | 'up' | 'down',
            );
      if (next) {
        ++recentJumpGeneration;
        focusPaneForTyping(next);
      }
      return;
    }
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !event.repeat &&
      !event.isComposing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !acpAgent &&
      focusedPane === 'main' &&
      running &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      void stop();
      return;
    }
    if (
      (focusedPane === 'main' && !acpAgent && !sessionID) ||
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

  function keyupWorkspace(event: KeyboardEvent) {
    if (event.key === 'Control') recentCycleKeys = null;
  }

  function focusWorkspace() {
    for (const pane of leaves(paneLayout)) if (pane.thread) markThreadRead(pane.thread);
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
<svelte:window
  onkeydown={keydownWorkspace}
  onkeyup={keyupWorkspace}
  onblur={() => (recentCycleKeys = null)}
  onfocus={focusWorkspace}
  onfocusin={cancelPendingPromptFocus}
/>
<div class="app-shell" data-mobile-view={mobileView}>
  <aside
    class="sidebar"
    aria-label="Projects and sessions"
    tabindex="-1"
    bind:this={sidebarElement}
  >
    <div class="brand"><span class="brand-mark">S.</span><span>Sail</span></div>
    <button class="inbox-launch" aria-label="Pending requests" onclick={openInbox}>
      Waiting for you <span>{inboxItems.length}</span>
    </button>
    <div class="sidebar-content">
      <ProjectSidebar
        catalog={projectCatalog}
        {directory}
        disabled={runtimeState !== 'connected' &&
          !agentAvailability.some((agent) => agent.available)}
        agents={agentAvailability}
        openCodeAvailable={runtimeState === 'connected'}
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
        ondeleteworktree={deleteProjectWorktree}
        oncreatepullrequest={createProjectPullRequest}
      />
      <div class="sidebar-sessions">
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
              : 'Complete Architect setup in OpenCode settings'}
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
          {@const attention = threadAttention[threadKey(thread)] ?? {
            status: 'done',
            unread: false,
          }}
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
                  ><span
                    class="thread-status-dot"
                    class:working={attention.status === 'working'}
                    class:waiting={attention.status === 'waiting'}
                    class:failed={attention.status === 'failed'}
                  ></span>{thread.agent}
                  · {attention.status === 'waiting' ? 'Waiting for input' : attention.status}</small
                ></span
              >
              {#if attention.unread}<span
                  class="thread-unread"
                  role="status"
                  aria-label="Unread activity"
                ></span>{/if}
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
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        editingSessionID = null;
                      }
                    }}
                  />
                  <button aria-label="Save title" onclick={saveRename}>✓</button>
                  <button aria-label="Cancel rename" onclick={() => (editingSessionID = null)}
                    >×</button
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
                  ? 'No OpenCode sessions found'
                  : 'Choose a repository to begin'}
            </p>{/each}
        </nav>
        {#if directory && (sessionPageHistory.length || nextSessionCursor)}<div
            class="session-pages"
          >
            <button disabled={!sessionPageHistory.length || sessionLoading} onclick={previousPage}
              >Previous</button
            >
            <button disabled={!nextSessionCursor || sessionLoading} onclick={nextPage}>Next</button>
          </div>{/if}
      </div>
    </div>
    <div class="sidebar-footer">
      <button
        class="settings-launch"
        aria-label="Settings"
        title="Settings (⌘,)"
        onclick={openSettings}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" /><path
            d="m19.4 13.4 1.1.9-1.7 3-1.4-.4a8 8 0 0 1-1.8 1.1l-.3 1.5h-3.5l-.3-1.5a8 8 0 0 1-1.8-1.1l-1.4.4-1.7-3 1.1-.9a8 8 0 0 1 0-2.8l-1.1-.9 1.7-3 1.4.4a8 8 0 0 1 1.8-1.1l.3-1.5h3.5l.3 1.5a8 8 0 0 1 1.8 1.1l1.4-.4 1.7 3-1.1.9a8 8 0 0 1 0 2.8Z"
          /></svg
        >
      </button>
      <span class="sidebar-runtime" role="status"
        ><span class:connected={runtimeState === 'connected'} class="status-dot" aria-hidden="true"
        ></span><span>OpenCode {runtimeState}</span></span
      >
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
        {#if directory}<Button
            variant="ghost"
            size="sm"
            aria-pressed={!browserAccessDisabled}
            onclick={toggleAgentBrowserAccess}
            title="Toggle agent browser access for this project"
            >Agent browser {browserAccessDisabled ? 'off' : 'on'}</Button
          >{/if}
        {#if selectedWorktreeConfig?.run}<Button
            variant="ghost"
            size="sm"
            onclick={() => splitFocusedPane('row', 'terminal', selectedWorktreeConfig?.run)}
            >Run project</Button
          >{/if}
        {#if agentTerminals.length}<Button
            variant="ghost"
            size="sm"
            onclick={() => agentTerminalsDialog.showModal()}
            >Agent terminals ({agentTerminals.length})</Button
          >{/if}
        <Button variant="ghost" size="sm" onclick={openCommandsDialog}>Commands</Button>
        {#if sessionID || acpAgent || focusedPane !== 'main'}<Button
            variant="ghost"
            size="sm"
            onclick={toggleChanges}
            aria-controls="session-details"
            aria-expanded={focusedPane !== 'main'
              ? changesPanes.includes(focusedPane)
              : acpAgent
                ? agentChangesOpen
                : detailsOpen && activeSideTab === 'changes'}
            title="Toggle Changes (⌘L)">Changes</Button
          >{/if}
        {#if !acpAgent}<span role="status"
            ><Badge tone={workReady ? 'success' : 'neutral'}
              >{running
                ? 'Running'
                : workReady
                  ? 'Ready'
                  : setupLoading
                    ? 'Checking'
                    : setup?.model.state === 'action'
                      ? 'Model needed'
                      : 'Unavailable'}</Badge
            ></span
          >{/if}
      </div>
    </header>
    {#if $settingsError}<p class="notice error" role="alert">{$settingsError}</p>{/if}
    {#if setupError}<p class="notice error" role="alert">{setupError}</p>{/if}
    {#if error}<p class="notice error" role="alert">{error}</p>{/if}
    {#snippet mainPaneContent()}
      <div
        class:single={acpAgent ? !agentChangesOpen : !sessionID || !detailsOpen}
        class:closed={acpAgent ? !agentChangesOpen : !detailsOpen}
        class="workspace"
        style={`--details-width: ${visibleDetailsWidth}px`}
        bind:this={workspaceElement}
      >
        <main
          class="chat-area"
          aria-label="Session conversation"
          tabindex="-1"
          bind:this={chatArea}
        >
          {#if acpAgent}
            {#key acpAgent}
              <AgentWorkspace
                agent={acpAgent}
                agentName={agentAvailability.find((agent) => agent.id === acpAgent)?.name ??
                  acpAgent}
                {directory}
                thread={acpThread}
                focusPrompt={promptFocusPane === 'main'}
                picked={pickedAttachments.main}
                externalPrompt={pendingAgentBatches.main}
                onexternalresult={completeAgentBatch}
                onpickedconsumed={markPickConsumed}
                onpromptfocused={() => (promptFocusPane = null)}
                running={!!(acpThread && runningAgentThreads[agentThreadKey(acpThread)])}
                focused={focusedPane === 'main'}
                oncreated={createAgentThread}
                onactivity={saveAgentThread}
                onstatus={updateAgentThreadStatus}
                onterminal={(id) => void openAgentTerminal(id)}
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
                  <p class="eyebrow">{planReady ? 'PLAN WITH ARCHITECT' : 'START WORK'}</p>
                  <h1>What are we working on?</h1>
                  <p>
                    {planReady
                      ? 'Choose an agent and model, then describe the work. Use New plan for Architect-first planning.'
                      : workReady
                        ? 'Choose an OpenCode agent and describe the work.'
                        : agentAvailability.some((agent) => agent.available)
                          ? 'Choose an available agent to start in this repository.'
                          : 'Connect a model in OpenCode settings to start.'}
                  </p>
                  {#if !directory}<Button
                      onclick={() => chooseProject()}
                      disabled={runtimeState !== 'connected'}>Select repository</Button
                    >{/if}
                  {#if directory && !workReady}<div class="welcome-agents">
                      {#each agentAvailability.filter((agent) => agent.available) as agent (agent.id)}<Button
                          variant="secondary"
                          onclick={() => openAgent(agent.id)}>Start with {agent.name}</Button
                        >{/each}
                    </div>{/if}
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
            {#if workReady || sessionID}<div class="composer-wrap">
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
                            onclick={() => removeAttachedFile(path)}>×</button
                          ></span
                        >{/each}
                    </div>{/if}
                  <textarea
                    data-pane-prompt
                    aria-label="Message"
                    bind:value={draft}
                    onkeydown={keydown}
                    rows="3"
                    placeholder={inputReady
                      ? 'Describe the work or ask a question…'
                      : 'OpenCode needs a connected model…'}
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
              </div>{/if}
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
                  {directory}
                  files={diffs}
                  annotations={acpAgent ? {} : diffAnnotations}
                  selected={selectedFilePath}
                  loading={diffLoading}
                  error={diffError}
                  onselect={(file) => (selectedFilePath = file)}
                  onrefresh={() => (acpAgent ? refreshAgentDiff() : refreshDiff())}
                  onclose={toggleChanges}
                  scope={diffCommentKey('main')}
                  comments={diffComments[diffCommentKey('main')] ?? []}
                  oncomments={updateDiffComments}
                  oncommentssent={removeSentDiffComments}
                  onsendcomments={(scope, text) => sendDiffComments('main', scope, text)}
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
    {/snippet}
    <PaneTree
      pane={paneLayout}
      focused={focusedPane}
      {directory}
      agents={agentAvailability}
      {changesPanes}
      main={mainPaneContent}
      canClose={leaves(paneLayout).length > 1}
      onfocus={focusPane}
      onclose={closeFocusedPane}
      onratio={updatePaneRatio}
      oncreated={createPaneThread}
      onchooseagent={choosePaneAgent}
      onchooseterminal={choosePaneTerminal}
      onchoosebrowser={choosePaneBrowser}
      onbrowserstate={updatePaneBrowser}
      onbrowserpick={attachPickedElement}
      {pickedAttachments}
      {diffComments}
      ondiffcomments={updateDiffComments}
      ondiffcommentssent={removeSentDiffComments}
      onsenddiffcomments={sendDiffComments}
      {pendingAgentBatches}
      onbatchcomplete={completeAgentBatch}
      onpickedconsumed={markPickConsumed}
      onshortcut={keydownWorkspace}
      onactivity={saveAgentThread}
      focusPromptPane={promptFocusPane}
      onpromptfocused={() => (promptFocusPane = null)}
      running={(thread) => !!(thread && runningAgentThreads[agentThreadKey(thread)])}
      onstatus={updateAgentThreadStatus}
      onchanges={(id) => {
        changesPanes = changesPanes.filter((item) => item !== id);
      }}
      {pendingCommands}
      oncommandstarted={(id) => {
        const next = { ...pendingCommands };
        delete next[id];
        pendingCommands = next;
      }}
      onterminalexit={(id, code) => {
        terminalExitWaiters.get(id)?.(code);
        terminalExitWaiters.delete(id);
      }}
      onagentterminal={(id) => void openAgentTerminal(id)}
    />
  </div>
</div>
<dialog
  class="command-palette"
  bind:this={paletteDialog}
  aria-label="Jump to project, thread, or command"
  onclose={commandPaletteClosed}
>
  <div class="palette-search">
    <input
      bind:this={paletteInput}
      value={paletteQuery}
      aria-label="Search projects, worktrees, threads, and commands"
      placeholder="Jump to project, thread, or command…"
      oninput={(event) => {
        paletteQuery = event.currentTarget.value;
        paletteIndex = 0;
        scrollToActivePaletteEntry();
      }}
      onkeydown={keydownCommandPalette}
    />
    <kbd>Esc</kbd>
  </div>
  <div class="palette-results">
    {#each paletteEntries as entry, index (entry.id)}
      <button
        class="palette-entry"
        class:active={index === paletteIndex}
        aria-current={index === paletteIndex ? 'true' : undefined}
        onclick={() => void choosePaletteEntry(entry)}
      >
        <span><strong>{entry.label}</strong><small>{entry.detail}</small></span>
        <span class="palette-kind"
          >{entry.kind === 'thread'
            ? 'Thread'
            : entry.kind === 'command'
              ? 'Command'
              : 'Project'}</span
        >
      </button>
    {:else}
      <div class="palette-empty">
        <p>No matches for “{paletteQuery}”.</p>
        <button
          disabled={!directory || !agentAvailability.some((agent) => agent.available)}
          onclick={() => void choosePaletteEntry(null)}
        >
          Start a thread in the current project
        </button>
      </div>
    {/each}
  </div>
</dialog>
<dialog class="commands-dialog" bind:this={agentTerminalsDialog} aria-label="Agent terminals">
  <div class="commands-header">
    <h2>Agent terminals</h2>
    <button aria-label="Close agent terminals" onclick={() => agentTerminalsDialog.close()}
      >×</button
    >
  </div>
  <div class="commands-list">
    {#each agentTerminals as terminal (terminal.terminalId)}
      <div class="commands-row">
        <span
          ><strong>{terminal.command}</strong><small>{terminal.agent} · {terminal.directory}</small
          ></span
        >
        <button onclick={() => void openAgentTerminal(terminal.terminalId)}>Open</button>
      </div>
    {/each}
  </div>
</dialog>
<dialog class="commands-dialog" bind:this={commandsDialog} aria-label="Saved commands">
  <div class="commands-header">
    <h2>Saved commands</h2>
    <button aria-label="Close saved commands" onclick={() => commandsDialog.close()}>×</button>
  </div>
  <div class="commands-list">
    {#each commandsForDirectory(savedCommands, projectCatalog, directory) as command (command.id)}
      <div class="commands-row">
        <span
          ><strong>{command.name}</strong><small
            >{command.project ? command.project.split(/[\\/]/).at(-1) : 'Global'} · {command.command}</small
          ></span
        >
        <button
          aria-label={`Edit ${command.name}`}
          onclick={() => {
            editingCommand = command.id;
            commandName = command.name;
            commandText = command.command;
            commandScope = command.project ? 'project' : 'global';
          }}>Edit</button
        ><button
          aria-label={`Delete ${command.name}`}
          onclick={() => saveCommands(savedCommands.filter((item) => item.id !== command.id))}
          >Delete</button
        >
      </div>
    {:else}<p>No commands saved yet.</p>{/each}
  </div>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      saveCommand();
    }}
  >
    <label>Name<input bind:value={commandName} required /></label>
    <label>Command<textarea bind:value={commandText} required rows="3"></textarea></label>
    <label
      >Scope<select bind:value={commandScope}>
        <option value="global">Global</option>
        <option value="project" disabled={!selectedRepository(projectCatalog, directory)}
          >Current project</option
        >
      </select></label
    >
    <button type="submit" disabled={!commandName.trim() || !commandText.trim()}
      >{editingCommand ? 'Save changes' : 'Save command'}</button
    >
  </form>
</dialog>
<dialog class="inbox-dialog" bind:this={inboxDialog} aria-label="Pending requests across projects">
  <div class="inbox-dialog-top">
    <span>All projects</span>
    <button aria-label="Close pending requests" onclick={() => inboxDialog.close()}>×</button>
  </div>
  {#if inboxError}<p class="notice error" role="alert">{inboxError}</p>{/if}
  <InboxPanel
    items={inboxItems}
    loading={inboxLoading}
    error={inboxError}
    onopen={(item) => void openInboxItem(item)}
    ondecide={decideInbox}
  />
</dialog>
