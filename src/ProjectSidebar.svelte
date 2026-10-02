<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import { invoke } from '@tauri-apps/api/core';
  import type { AgentAvailability } from './lib/acp';
  import type { ProjectCatalog, ProjectWorktree } from './lib/projects';
  import { ungroupedRepositories } from './lib/projects';
  import { getSetting, setSetting } from './lib/settings';
  import { issueBranch } from './lib/github-issues';

  export type PullRequestCheck = { name: string; state: string; url: string };
  type PullRequestChecks = { number: number; url: string; checks: PullRequestCheck[] };
  type RepositoryChecks = {
    checks: Record<string, PullRequestChecks | null>;
    errors: Record<string, string>;
  };
  export type GitHubIssue = { number: number; title: string; body: string; url: string };

  type Props = {
    catalog: ProjectCatalog;
    directory: string;
    disabled: boolean;
    agents: AgentAvailability[];
    openCodeAvailable: boolean;
    worktreeDialogRequest: { id: string; path: string } | null;
    onworktreecreated: (repository: string, path: string) => void;
    onworktreecancelled: (repository: string) => void;
    onselect: (path: string) => void;
    onaddrepository: (groupID: string | null) => void;
    onaddgroup: (name: string) => void;
    onrenamegroup: (id: string, name: string) => void;
    ondeletegroup: (id: string) => void;
    ontogglegroup: (id: string) => void;
    ontogglerepository: (path: string) => void;
    onmoverepository: (path: string, groupID: string | null) => void;
    onremoverepository: (path: string) => void;
    oncreateworktree: (
      path: string,
      name: string,
      destinationParent: string | null,
      baseRef: string | null,
      agent: string | null,
      issue: GitHubIssue | null,
    ) => Promise<void>;
    ondeleteworktree: (repository: string, path: string, branch: string) => Promise<void>;
    oncreatepullrequest: (
      repository: string,
      worktree: ProjectWorktree,
      base: string,
      title: string,
      body: string,
      draft: boolean,
    ) => Promise<void>;
    onsendchecklog: (
      repository: string,
      worktree: ProjectWorktree,
      check: PullRequestCheck,
    ) => Promise<void>;
  };

  type MenuTarget =
    | { kind: 'group'; id: string; name: string }
    | { kind: 'repository'; path: string; groupID: string | null }
    | { kind: 'worktree'; repository: string; worktree: ProjectWorktree };

  let {
    catalog,
    directory,
    disabled,
    agents,
    openCodeAvailable,
    worktreeDialogRequest,
    onworktreecreated,
    onworktreecancelled,
    onselect,
    onaddrepository,
    onaddgroup,
    onrenamegroup,
    ondeletegroup,
    ontogglegroup,
    ontogglerepository,
    onmoverepository,
    onremoverepository,
    oncreateworktree,
    ondeleteworktree,
    oncreatepullrequest,
    onsendchecklog,
  }: Props = $props();
  let creatingGroup = $state(false);
  let editingGroupID = $state<string | null>(null);
  let groupName = $state('');
  let addGroupButton: HTMLButtonElement;
  let groupNameInput = $state<HTMLInputElement>();
  let menu = $state<MenuTarget | null>(null);
  let menuElement = $state<HTMLDivElement>();
  let menuX = $state(0);
  let menuY = $state(0);
  let menuTrigger: HTMLElement | null = null;
  let creatingWorktreeFor = $state<string | null>(null);
  let worktreeFromPalette = $state(false);
  let worktreeCreated = false;
  let lastWorktreeRequest = '';
  let worktreeDialog: HTMLDialogElement;
  let worktreeNameInput = $state<HTMLInputElement>();
  let worktreeName = $state('');
  let worktreeDestination = $state<string | null>(null);
  let worktreeBase = $state('');
  let worktreeAgent = $state('');
  let worktreeAgentTouched = $state(false);
  let worktreeBusy = $state(false);
  let worktreeError = $state('');
  let issueQuery = $state('');
  let issueResults = $state<GitHubIssue[]>([]);
  let issueError = $state('');
  let issueLoading = $state(false);
  let selectedIssue = $state<GitHubIssue | null>(null);
  let issueSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let issueSearchGeneration = 0;
  let creatingPullRequestFor = $state<{ repository: string; worktree: ProjectWorktree } | null>(
    null,
  );
  let pullRequestDialog: HTMLDialogElement;
  let pullRequestTitleInput = $state<HTMLInputElement>();
  let pullRequestBase = $state('');
  let pullRequestTitle = $state('');
  let pullRequestBody = $state('');
  let pullRequestDraft = $state(false);
  let pullRequestBusy = $state(false);
  let pullRequestError = $state('');
  let ungrouped = $derived(ungroupedRepositories(catalog));
  let pullRequestChecks = $state<Record<string, PullRequestChecks | null>>({});
  let checkErrors = $state<Record<string, string>>({});
  let sendingCheck = $state<string | null>(null);
  let checking = false;
  let collapsedRepositoryPaths = $derived(new Set(catalog.collapsedRepositories ?? []));

  function repositoryCollapsed(path: string): boolean {
    return collapsedRepositoryPaths.has(path);
  }

  function repositoryWorktreesID(path: string): string {
    return `project-worktrees-${encodeURIComponent(path)}`;
  }

  function checkState(check: PullRequestCheck) {
    if (
      [
        'FAILURE',
        'ERROR',
        'TIMED_OUT',
        'CANCELLED',
        'ACTION_REQUIRED',
        'STALE',
        'STARTUP_FAILURE',
      ].includes(check.state)
    )
      return 'failing';
    if (['SUCCESS', 'EXPECTED', 'NEUTRAL', 'SKIPPED'].includes(check.state)) return 'passing';
    return 'pending';
  }

  function hasActionsLog(url: string) {
    return /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+$/.test(url);
  }

  function overallState(checks: PullRequestCheck[]) {
    if (checks.some((check) => checkState(check) === 'failing')) return 'failing';
    if (checks.length && checks.every((check) => checkState(check) === 'passing')) return 'passing';
    return 'pending';
  }

  function currentPullRequest(worktree: ProjectWorktree): PullRequestChecks | null {
    if (worktree.path in pullRequestChecks) return pullRequestChecks[worktree.path];
    return worktree.pullRequest ? { ...worktree.pullRequest, checks: [] } : null;
  }

  async function refreshChecks() {
    if (checking) return;
    checking = true;
    try {
      const entries = Object.entries(catalog.worktrees).filter(([, worktrees]) => worktrees.length);
      const results = await Promise.allSettled(
        entries.map(([repository, worktrees]) =>
          invoke<RepositoryChecks>('pull_request_checks', {
            repository,
            worktrees: worktrees.map(({ path, branch }) => ({ path, branch })),
          }),
        ),
      );
      const next: Record<string, PullRequestChecks | null> = {};
      const errors: Record<string, string> = {};
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          Object.assign(next, result.value.checks);
          Object.assign(errors, result.value.errors);
        } else {
          const cause =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          for (const worktree of entries[index][1]) errors[worktree.path] = cause;
        }
      });
      pullRequestChecks = next;
      checkErrors = errors;
    } finally {
      checking = false;
    }
  }

  onMount(() => {
    void refreshChecks();
    const timer = setInterval(() => void refreshChecks(), 30_000);
    return () => clearInterval(timer);
  });

  async function sendCheckLog(
    repository: string,
    worktree: ProjectWorktree,
    check: PullRequestCheck,
  ) {
    sendingCheck = `${worktree.path}:${check.name}`;
    try {
      await onsendchecklog(repository, worktree, check);
    } catch (cause) {
      checkErrors = {
        ...checkErrors,
        [worktree.path]: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      sendingCheck = null;
    }
  }

  function closeMenu(restoreFocus = false) {
    menu = null;
    if (restoreFocus) menuTrigger?.focus();
    menuTrigger = null;
  }

  function menuKey(target: MenuTarget) {
    if (target.kind === 'group') return `group:${target.id}`;
    if (target.kind === 'repository') return `repository:${target.path}`;
    return `worktree:${target.worktree.path}`;
  }

  async function openMenu(target: MenuTarget, event: MouseEvent, trigger?: HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'click' && menu && menuKey(menu) === menuKey(target)) {
      closeMenu();
      return;
    }
    menu = target;
    menuTrigger =
      trigger ??
      (event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null);
    const bounds = trigger?.getBoundingClientRect();
    menuX = bounds ? bounds.right : event.clientX;
    menuY = bounds ? bounds.bottom : event.clientY;
    await tick();
    if (!menuElement) return;
    menuX = Math.max(8, Math.min(menuX, innerWidth - menuElement.offsetWidth - 8));
    menuY = Math.max(8, Math.min(menuY, innerHeight - menuElement.offsetHeight - 8));
    menuElement.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  function navigateMenu(event: KeyboardEvent) {
    if (!menuElement || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...menuElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
    items[next].focus();
  }

  function repositoryName(path: string) {
    return (
      path
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .at(-1) ?? path
    );
  }

  function saveGroup() {
    const name = groupName.trim();
    if (!name) return;
    if (editingGroupID) onrenamegroup(editingGroupID, name);
    else onaddgroup(name);
    creatingGroup = false;
    editingGroupID = null;
    groupName = '';
  }

  async function startGroup() {
    creatingGroup = true;
    editingGroupID = null;
    groupName = '';
    await tick();
    groupNameInput?.focus();
  }

  async function startRename(id: string, name: string) {
    editingGroupID = id;
    groupName = name;
    closeMenu();
    await tick();
    groupNameInput?.focus();
  }

  function cancelGroup() {
    creatingGroup = false;
    editingGroupID = null;
    groupName = '';
    void tick().then(() => addGroupButton?.focus());
  }

  $effect(() => {
    const request = worktreeDialogRequest;
    if (!request || request.id === lastWorktreeRequest) return;
    lastWorktreeRequest = request.id;
    void startWorktree(request.path, true);
  });

  async function startWorktree(path: string, fromPalette = false) {
    creatingWorktreeFor = path;
    worktreeFromPalette = fromPalette;
    worktreeCreated = false;
    worktreeName = '';
    worktreeDestination = null;
    worktreeBase = '';
    worktreeAgentTouched = false;
    const savedAgent = getSetting('sai-worktree-agent') ?? '';
    worktreeAgent =
      !fromPalette &&
      ((savedAgent === 'opencode' && openCodeAvailable) ||
        agents.some((agent) => agent.id === savedAgent && agent.available))
        ? savedAgent
        : '';
    worktreeError = '';
    selectedIssue = null;
    issueQuery = '';
    issueResults = [];
    issueError = '';
    closeMenu();
    await tick();
    worktreeDialog.showModal();
    worktreeNameInput?.focus();
    if (!fromPalette) void loadIssues(path);
  }

  async function loadIssues(repository: string) {
    const generation = ++issueSearchGeneration;
    issueLoading = true;
    issueError = '';
    try {
      const issues = await invoke<GitHubIssue[]>('list_open_issues', {
        repository,
        query: issueQuery,
      });
      if (generation === issueSearchGeneration && creatingWorktreeFor === repository)
        issueResults = issues;
    } catch (cause) {
      if (generation === issueSearchGeneration && creatingWorktreeFor === repository)
        issueError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (generation === issueSearchGeneration) issueLoading = false;
    }
  }

  function searchIssues(repository: string) {
    clearTimeout(issueSearchTimer);
    issueSearchTimer = setTimeout(() => void loadIssues(repository), 300);
  }

  function chooseIssue(issue: GitHubIssue) {
    selectedIssue = issue;
    worktreeName = issueBranch(issue);
    if (!worktreeAgentTouched)
      worktreeAgent =
        agents.find((agent) => agent.available)?.id ?? (openCodeAvailable ? 'opencode' : '');
    void tick().then(() => worktreeNameInput?.focus());
  }

  async function chooseWorktreeDestination() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Worktree parent folder',
    });
    if (typeof selected === 'string') worktreeDestination = selected;
  }

  async function createWorktree(path: string) {
    if (!worktreeName.trim() || worktreeBusy) return;
    if (selectedIssue && !worktreeAgent) {
      worktreeError = 'Choose an available agent to start this issue.';
      return;
    }
    worktreeBusy = true;
    worktreeError = '';
    try {
      const fromPalette = worktreeFromPalette;
      await oncreateworktree(
        path,
        worktreeName.trim(),
        worktreeDestination,
        worktreeBase.trim() || null,
        fromPalette ? null : worktreeAgent || null,
        fromPalette ? null : selectedIssue,
      );
      if (!fromPalette) setSetting('sai-worktree-agent', worktreeAgent);
      worktreeCreated = true;
      worktreeDialog.close();
      if (fromPalette) {
        await tick();
        onworktreecreated(path, directory);
      }
    } catch (cause) {
      worktreeError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      worktreeBusy = false;
    }
  }

  function closeWorktreeDialog() {
    if (!worktreeBusy) {
      clearTimeout(issueSearchTimer);
      ++issueSearchGeneration;
      worktreeDialog.close();
    }
  }

  async function startPullRequest(repository: string, worktree: ProjectWorktree) {
    creatingPullRequestFor = { repository, worktree };
    const base = worktree.base?.replace(/^origin\//, '');
    pullRequestBase = base && base !== 'HEAD' ? base : 'main';
    pullRequestTitle = worktree.branch.replace(/[-_]+/g, ' ');
    pullRequestBody = '';
    pullRequestDraft = false;
    pullRequestError = '';
    closeMenu();
    await tick();
    pullRequestDialog.showModal();
    pullRequestTitleInput?.focus();
  }

  async function createPullRequest() {
    const target = creatingPullRequestFor;
    if (!target || pullRequestBusy || !pullRequestBase.trim() || !pullRequestTitle.trim()) return;
    pullRequestBusy = true;
    pullRequestError = '';
    try {
      await oncreatepullrequest(
        target.repository,
        target.worktree,
        pullRequestBase.trim(),
        pullRequestTitle.trim(),
        pullRequestBody,
        pullRequestDraft,
      );
      pullRequestDialog.close();
      void refreshChecks();
    } catch (cause) {
      pullRequestError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      pullRequestBusy = false;
    }
  }
</script>

<svelte:window
  onclick={(event) => {
    if (
      !menuElement?.contains(event.target as Node) &&
      !menuTrigger?.contains(event.target as Node)
    )
      closeMenu();
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape' && menu) {
      event.preventDefault();
      closeMenu(true);
    }
  }}
  onresize={() => closeMenu()}
/>
{#snippet checkBadge(worktree: ProjectWorktree)}
  {@const pr = currentPullRequest(worktree)}
  {#if pr}
    <a
      class="project-worktree-pr"
      href={pr.url}
      onclick={(event) => {
        event.preventDefault();
        void invoke('open_pull_request', { url: pr.url });
      }}
      aria-label={`Open pull request ${pr.number}`}
      title={`Open pull request #${pr.number}`}>#{pr.number}</a
    >
    {#if worktree.path in pullRequestChecks}
      <span
        class={`project-check-state ${overallState(pr.checks)}`}
        role="status"
        aria-label={`Pull request #${pr.number} checks ${overallState(pr.checks)}`}
        title={`Checks ${overallState(pr.checks)}`}
        >{overallState(pr.checks) === 'passing'
          ? '✓'
          : overallState(pr.checks) === 'failing'
            ? '!'
            : '…'}</span
      >
    {/if}
  {/if}
{/snippet}

{#snippet checkFailures(repository: string, worktree: ProjectWorktree)}
  {@const pr = currentPullRequest(worktree)}
  {#if pr && pr.checks.some((check) => checkState(check) === 'failing')}
    <div class="project-check-failures">
      {#each pr.checks.filter((check) => checkState(check) === 'failing') as check, index (index)}
        <div class="project-check-failure">
          {#if check.url}
            <a
              href={check.url}
              onclick={(event) => {
                event.preventDefault();
                void invoke('open_check_url', { url: check.url });
              }}>{check.name} ↗</a
            >
          {:else}<span>{check.name}</span>{/if}
          {#if check.url}<button
              aria-label={`Send ${check.name} ${hasActionsLog(check.url) ? 'logs' : 'link'} to agent in ${worktree.branch}`}
              disabled={sendingCheck !== null}
              onclick={() => void sendCheckLog(repository, worktree, check)}
              >{hasActionsLog(check.url) ? 'Send logs' : 'Send link'}</button
            >{/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if checkErrors[worktree.path] && pr}
    <p class="project-check-error" role="status">{checkErrors[worktree.path]}</p>
  {/if}
{/snippet}

<section class="projects" aria-label="Projects and repositories">
  <div class="projects-heading">
    <span class="label">PROJECTS</span>
    <button
      class="project-control"
      bind:this={addGroupButton}
      aria-label="Add project group"
      title="Add project group"
      onclick={startGroup}>+ Group</button
    >
    <button
      class="project-control"
      aria-label="Add repository"
      title="Add repository"
      {disabled}
      onclick={() => onaddrepository(null)}>+ Repo</button
    >
  </div>
  {#if creatingGroup}<form
      class="project-form"
      onsubmit={(event) => {
        event.preventDefault();
        saveGroup();
      }}
    >
      <input
        aria-label="New project group name"
        placeholder="Group name"
        bind:value={groupName}
        bind:this={groupNameInput}
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelGroup();
          }
        }}
      />
      <button type="submit" aria-label="Save project group">✓</button>
      <button type="button" aria-label="Cancel project group" onclick={cancelGroup}>×</button>
    </form>{/if}
  <nav class="project-list" aria-label="Repositories">
    {#each catalog.groups as group (group.id)}
      <div class="project-group">
        {#if editingGroupID === group.id}<form
            class="project-form"
            onsubmit={(event) => {
              event.preventDefault();
              saveGroup();
            }}
          >
            <input
              aria-label={`Rename ${group.name}`}
              bind:value={groupName}
              bind:this={groupNameInput}
              onkeydown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelGroup();
                }
              }}
            />
            <button type="submit" aria-label="Save group name">✓</button>
            <button type="button" aria-label="Cancel rename" onclick={cancelGroup}>×</button>
          </form>{:else}<div
            class="project-group-heading"
            role="group"
            oncontextmenu={(event) =>
              openMenu({ kind: 'group', id: group.id, name: group.name }, event)}
          >
            <button
              class="project-group-toggle"
              aria-expanded={!group.collapsed}
              onmousedown={(event) => {
                if (event.button === 2)
                  void openMenu({ kind: 'group', id: group.id, name: group.name }, event);
              }}
              onclick={() => ontogglegroup(group.id)}
              title={group.name}
              ><span aria-hidden="true">{group.collapsed ? '▸' : '▾'}</span>{group.name}</button
            >
            <button
              class="project-icon-button"
              aria-label={`Add repository to ${group.name}`}
              title="Add repository"
              {disabled}
              onclick={() => onaddrepository(group.id)}>+</button
            >
            <button
              class="project-icon-button"
              aria-label={`Manage ${group.name}`}
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'group' && menu.id === group.id}
              onclick={(event) =>
                openMenu(
                  { kind: 'group', id: group.id, name: group.name },
                  event,
                  event.currentTarget,
                )}>⋯</button
            >
          </div>{/if}
        {#if !group.collapsed}
          {#each group.repositories as path (path)}
            <div class="project-repository">
              <div
                class="project-repository-row"
                role="group"
                oncontextmenu={(event) =>
                  openMenu({ kind: 'repository', path, groupID: group.id }, event)}
              >
                <button
                  class="project-repository-select"
                  aria-expanded={!repositoryCollapsed(path)}
                  aria-controls={repositoryWorktreesID(path)}
                  title={path}
                  onmousedown={(event) => {
                    if (event.button === 2)
                      void openMenu({ kind: 'repository', path, groupID: group.id }, event);
                  }}
                  onclick={() => ontogglerepository(path)}
                  {disabled}
                  ><span aria-hidden="true">{repositoryCollapsed(path) ? '▸' : '▾'}</span><span
                    >{repositoryName(path)}</span
                  ></button
                >
                <button
                  class="project-icon-button"
                  aria-label={`Create worktree for ${repositoryName(path)}`}
                  title="Create worktree"
                  {disabled}
                  onclick={() => startWorktree(path)}>+</button
                >
                <button
                  class="project-icon-button"
                  aria-label={`Manage ${repositoryName(path)}`}
                  aria-haspopup="menu"
                  aria-expanded={menu?.kind === 'repository' && menu.path === path}
                  onclick={(event) =>
                    openMenu(
                      { kind: 'repository', path, groupID: group.id },
                      event,
                      event.currentTarget,
                    )}>⋯</button
                >
              </div>
              <div
                class="project-worktree-list"
                id={repositoryWorktreesID(path)}
                hidden={repositoryCollapsed(path)}
              >
                <div class:active={path === directory} class="project-worktree-row" role="group">
                  <button
                    class="project-worktree-select project-default-worktree-select"
                    aria-label={`Open default worktree for ${repositoryName(path)}`}
                    aria-current={path === directory ? 'page' : undefined}
                    title={path}
                    {disabled}
                    onclick={() => onselect(path)}
                    ><span aria-hidden="true">⑂</span><span>Default</span></button
                  >
                </div>
                {#each catalog.worktrees[path] ?? [] as worktree (worktree.path)}<div
                    class:active={worktree.path === directory}
                    class="project-worktree-row"
                    role="group"
                    oncontextmenu={(event) =>
                      openMenu({ kind: 'worktree', repository: path, worktree }, event)}
                  >
                    <button
                      class="project-worktree-select"
                      aria-current={worktree.path === directory ? 'page' : undefined}
                      title={worktree.path}
                      {disabled}
                      onmousedown={(event) => {
                        if (event.button === 2)
                          void openMenu({ kind: 'worktree', repository: path, worktree }, event);
                      }}
                      onclick={() => onselect(worktree.path)}
                      ><span aria-hidden="true">⑂</span><span>{worktree.branch}</span></button
                    >
                    {@render checkBadge(worktree)}
                    <button
                      class="project-icon-button"
                      aria-label={`Manage worktree ${worktree.branch}`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.kind === 'worktree' &&
                        menu.worktree.path === worktree.path}
                      onclick={(event) =>
                        openMenu(
                          { kind: 'worktree', repository: path, worktree },
                          event,
                          event.currentTarget,
                        )}>⋯</button
                    >
                  </div>
                  {@render checkFailures(path, worktree)}
                {/each}
              </div>
            </div>
          {:else}<p class="project-empty">No repositories</p>{/each}
        {/if}
      </div>
    {/each}
    {#if ungrouped.length || !catalog.groups.length}<div class="project-group">
        <div class="project-group-heading"><span class="project-group-label">Ungrouped</span></div>
        {#each ungrouped as path (path)}
          <div class="project-repository">
            <div
              class="project-repository-row"
              role="group"
              oncontextmenu={(event) =>
                openMenu({ kind: 'repository', path, groupID: null }, event)}
            >
              <button
                class="project-repository-select"
                aria-expanded={!repositoryCollapsed(path)}
                aria-controls={repositoryWorktreesID(path)}
                title={path}
                onmousedown={(event) => {
                  if (event.button === 2)
                    void openMenu({ kind: 'repository', path, groupID: null }, event);
                }}
                onclick={() => ontogglerepository(path)}
                {disabled}
                ><span aria-hidden="true">{repositoryCollapsed(path) ? '▸' : '▾'}</span><span
                  >{repositoryName(path)}</span
                ></button
              >
              <button
                class="project-icon-button"
                aria-label={`Create worktree for ${repositoryName(path)}`}
                title="Create worktree"
                {disabled}
                onclick={() => startWorktree(path)}>+</button
              >
              <button
                class="project-icon-button"
                aria-label={`Manage ${repositoryName(path)}`}
                aria-haspopup="menu"
                aria-expanded={menu?.kind === 'repository' && menu.path === path}
                onclick={(event) =>
                  openMenu({ kind: 'repository', path, groupID: null }, event, event.currentTarget)}
                >⋯</button
              >
            </div>
            <div
              class="project-worktree-list"
              id={repositoryWorktreesID(path)}
              hidden={repositoryCollapsed(path)}
            >
              <div class:active={path === directory} class="project-worktree-row" role="group">
                <button
                  class="project-worktree-select project-default-worktree-select"
                  aria-label={`Open default worktree for ${repositoryName(path)}`}
                  aria-current={path === directory ? 'page' : undefined}
                  title={path}
                  {disabled}
                  onclick={() => onselect(path)}
                  ><span aria-hidden="true">⑂</span><span>Default</span></button
                >
              </div>
              {#each catalog.worktrees[path] ?? [] as worktree (worktree.path)}<div
                  class:active={worktree.path === directory}
                  class="project-worktree-row"
                  role="group"
                  oncontextmenu={(event) =>
                    openMenu({ kind: 'worktree', repository: path, worktree }, event)}
                >
                  <button
                    class="project-worktree-select"
                    aria-current={worktree.path === directory ? 'page' : undefined}
                    title={worktree.path}
                    {disabled}
                    onmousedown={(event) => {
                      if (event.button === 2)
                        void openMenu({ kind: 'worktree', repository: path, worktree }, event);
                    }}
                    onclick={() => onselect(worktree.path)}
                    ><span aria-hidden="true">⑂</span><span>{worktree.branch}</span></button
                  >
                  {@render checkBadge(worktree)}
                  <button
                    class="project-icon-button"
                    aria-label={`Manage worktree ${worktree.branch}`}
                    aria-haspopup="menu"
                    aria-expanded={menu?.kind === 'worktree' &&
                      menu.worktree.path === worktree.path}
                    onclick={(event) =>
                      openMenu(
                        { kind: 'worktree', repository: path, worktree },
                        event,
                        event.currentTarget,
                      )}>⋯</button
                  >
                </div>
                {@render checkFailures(path, worktree)}
              {/each}
            </div>
          </div>
        {:else}<p class="project-empty">Add a repository to switch between projects.</p>{/each}
      </div>{/if}
  </nav>
</section>

{#if menu}{@const target = menu}
  <div
    class:worktree-menu={target.kind === 'worktree'}
    class="project-menu"
    role="menu"
    tabindex="-1"
    aria-label={target.kind === 'group'
      ? `Manage ${target.name}`
      : target.kind === 'repository'
        ? `Manage ${repositoryName(target.path)}`
        : `Manage worktree ${target.worktree.branch}`}
    style={`left: ${menuX}px; top: ${menuY}px`}
    bind:this={menuElement}
    onkeydown={navigateMenu}
    onclick={(event) => event.stopPropagation()}
  >
    {#if target.kind === 'group'}
      <div class="project-menu-title">{target.name}</div>
      <button
        role="menuitem"
        {disabled}
        onclick={() => {
          onaddrepository(target.id);
          closeMenu();
        }}>Add repository…</button
      >
      <button role="menuitem" onclick={() => startRename(target.id, target.name)}
        >Rename group…</button
      >
      <div class="project-menu-divider"></div>
      <button
        role="menuitem"
        class="danger"
        onclick={() => {
          ondeletegroup(target.id);
          closeMenu();
        }}>Delete group</button
      >
    {:else if target.kind === 'repository'}
      <div class="project-menu-title" title={target.path}>{repositoryName(target.path)}</div>
      <button role="menuitem" {disabled} onclick={() => startWorktree(target.path)}
        >Create worktree…</button
      >
      {#if catalog.groups.length || target.groupID}
        <div class="project-menu-divider"></div>
        <div class="project-menu-label">Move to</div>
        {#if target.groupID}<button
            role="menuitem"
            aria-label={`Move ${repositoryName(target.path)} to Ungrouped`}
            onclick={() => {
              onmoverepository(target.path, null);
              closeMenu();
            }}>Ungrouped</button
          >{/if}
        {#each catalog.groups.filter((group) => group.id !== target.groupID) as destination (destination.id)}
          <button
            role="menuitem"
            aria-label={`Move ${repositoryName(target.path)} to ${destination.name}`}
            onclick={() => {
              onmoverepository(target.path, destination.id);
              closeMenu();
            }}>{destination.name}</button
          >
        {/each}
      {/if}
      <div class="project-menu-divider"></div>
      <button
        role="menuitem"
        class="danger"
        disabled={target.path === directory ||
          (catalog.worktrees[target.path] ?? []).some((worktree) => worktree.path === directory)}
        title={target.path === directory ||
        (catalog.worktrees[target.path] ?? []).some((worktree) => worktree.path === directory)
          ? 'Switch repositories before removing this one'
          : 'Remove from sidebar'}
        onclick={() => {
          onremoverepository(target.path);
          closeMenu();
        }}>Remove from sidebar</button
      >
    {:else}
      <div class="project-menu-title" title={target.worktree.path}>{target.worktree.branch}</div>
      {#if !currentPullRequest(target.worktree)}<button
          role="menuitem"
          aria-label={`Create pull request for ${target.worktree.branch}`}
          onclick={() => startPullRequest(target.repository, target.worktree)}
          >Create pull request…</button
        >{/if}
      <button
        role="menuitem"
        class="danger"
        aria-label={`Delete worktree ${target.worktree.branch}`}
        onclick={() => {
          closeMenu();
          void ondeleteworktree(target.repository, target.worktree.path, target.worktree.branch);
        }}>Delete worktree…</button
      >
    {/if}
  </div>{/if}

<dialog
  class="worktree-dialog"
  aria-labelledby="worktree-dialog-title"
  bind:this={worktreeDialog}
  oncancel={(event) => {
    if (worktreeBusy) event.preventDefault();
  }}
  onclose={() => {
    const repository = creatingWorktreeFor;
    const returnToPalette = worktreeFromPalette && !worktreeCreated;
    creatingWorktreeFor = null;
    worktreeFromPalette = false;
    clearTimeout(issueSearchTimer);
    ++issueSearchGeneration;
    if (returnToPalette && repository)
      void tick().then(() => {
        onworktreecancelled(repository);
        return undefined;
      });
  }}
>
  {#if creatingWorktreeFor}<form
      class="worktree-form"
      onsubmit={(event) => {
        event.preventDefault();
        void createWorktree(creatingWorktreeFor!);
      }}
    >
      <div class="worktree-dialog-heading">
        <div>
          <h2 id="worktree-dialog-title">Create worktree</h2>
          <p title={creatingWorktreeFor}>For {repositoryName(creatingWorktreeFor)}</p>
        </div>
        <button
          type="button"
          class="worktree-dialog-close"
          aria-label="Close worktree dialog"
          onclick={closeWorktreeDialog}
          disabled={worktreeBusy}>×</button
        >
      </div>
      {#if !worktreeFromPalette}<label
          >Open GitHub issue <span>(optional)</span>
          <input
            aria-label="Search open GitHub issues"
            placeholder="Search by title or number"
            bind:value={issueQuery}
            oninput={() => searchIssues(creatingWorktreeFor!)}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                clearTimeout(issueSearchTimer);
                void loadIssues(creatingWorktreeFor!);
              }
            }}
            disabled={worktreeBusy}
          />
        </label>{/if}
      {#if issueLoading && !worktreeFromPalette}<p class="worktree-issue-note" role="status">
          Searching issues…
        </p>{/if}
      {#if issueError && !worktreeFromPalette}<p class="worktree-error" role="status">
          {issueError}
        </p>{/if}
      {#if !worktreeFromPalette && !issueLoading && !issueError && !issueResults.length}<p
          class="worktree-issue-note"
          role="status"
        >
          No open issues found.
        </p>{/if}
      {#if !worktreeFromPalette && !issueError && !issueLoading && issueResults.length}<div
          class="worktree-issue-results"
          aria-label="Open GitHub issues"
        >
          {#each issueResults as issue (issue.number)}<button
              type="button"
              class:selected={selectedIssue?.number === issue.number}
              aria-pressed={selectedIssue?.number === issue.number}
              onclick={() => chooseIssue(issue)}
              disabled={worktreeBusy}>#{issue.number} {issue.title}</button
            >{/each}
        </div>{/if}
      {#if !worktreeFromPalette && selectedIssue}<p class="worktree-issue-note">
          Selected #{selectedIssue.number}: {selectedIssue.title}
          <button type="button" onclick={() => (selectedIssue = null)} disabled={worktreeBusy}
            >Clear</button
          >
        </p>{/if}
      <label
        >New branch name
        <input
          aria-label={`Worktree name for ${repositoryName(creatingWorktreeFor)}`}
          placeholder="e.g. my-feature"
          bind:value={worktreeName}
          bind:this={worktreeNameInput}
          disabled={worktreeBusy}
        />
      </label>
      <label
        >Base branch <span>(optional)</span>
        <input
          aria-label={`Base branch for ${repositoryName(creatingWorktreeFor)}`}
          placeholder="Auto-detect"
          bind:value={worktreeBase}
          disabled={worktreeBusy}
        />
      </label>
      {#if !worktreeFromPalette}<label
          >Start with agent
          <select
            aria-label="Agent for new worktree"
            bind:value={worktreeAgent}
            onchange={() => (worktreeAgentTouched = true)}
            disabled={worktreeBusy}
          >
            <option value="">Choose after creation</option>
            <option value="opencode" disabled={!openCodeAvailable}>OpenCode</option>
            {#each agents as agent (agent.id)}<option value={agent.id} disabled={!agent.available}
                >{agent.name}</option
              >{/each}
          </select>
        </label>{:else}<p class="worktree-issue-note">
          Choose an agent and session after creation.
        </p>{/if}
      {#if selectedIssue && !worktreeAgent}<p class="worktree-issue-note" role="status">
          Choose an available agent to start this issue.
        </p>{/if}
      <div class="worktree-destination">
        <div>
          <strong>Location</strong><span title={worktreeDestination ?? '~/sail/worktrees'}
            >{worktreeDestination ?? 'Sail worktrees folder'}</span
          >
        </div>
        <button type="button" onclick={chooseWorktreeDestination} disabled={worktreeBusy}
          >Choose folder…</button
        >
      </div>
      {#if worktreeError}<p class="worktree-error" role="alert">{worktreeError}</p>{/if}
      <div class="worktree-form-actions">
        <button
          type="button"
          class="worktree-cancel"
          disabled={worktreeBusy}
          onclick={closeWorktreeDialog}>Cancel</button
        >
        <button
          type="submit"
          class="worktree-create"
          disabled={worktreeBusy || !worktreeName.trim() || (!!selectedIssue && !worktreeAgent)}
          >{worktreeBusy ? 'Creating…' : 'Create worktree'}</button
        >
      </div>
    </form>{/if}
</dialog>

<dialog
  class="worktree-dialog"
  aria-labelledby="pull-request-dialog-title"
  bind:this={pullRequestDialog}
  oncancel={(event) => {
    if (pullRequestBusy) event.preventDefault();
  }}
  onclose={() => (creatingPullRequestFor = null)}
>
  {#if creatingPullRequestFor}<form
      class="worktree-form"
      onsubmit={(event) => {
        event.preventDefault();
        void createPullRequest();
      }}
    >
      <div class="worktree-dialog-heading">
        <div>
          <h2 id="pull-request-dialog-title">Create pull request</h2>
          <p title={creatingPullRequestFor.worktree.path}>
            For {creatingPullRequestFor.worktree.branch}
          </p>
        </div>
        <button
          type="button"
          class="worktree-dialog-close"
          aria-label="Close pull request dialog"
          onclick={() => pullRequestDialog.close()}
          disabled={pullRequestBusy}>×</button
        >
      </div>
      <label
        >Base branch
        <input
          aria-label="Pull request base branch"
          bind:value={pullRequestBase}
          disabled={pullRequestBusy}
        />
      </label>
      <label
        >Title
        <input
          aria-label="Pull request title"
          bind:value={pullRequestTitle}
          bind:this={pullRequestTitleInput}
          disabled={pullRequestBusy}
        />
      </label>
      <label
        >Body
        <textarea
          aria-label="Pull request body"
          bind:value={pullRequestBody}
          disabled={pullRequestBusy}></textarea>
      </label>
      <label class="pull-request-draft"
        ><input type="checkbox" bind:checked={pullRequestDraft} disabled={pullRequestBusy} /> Create as
        draft</label
      >
      {#if pullRequestError}<p class="worktree-error" role="alert">{pullRequestError}</p>{/if}
      <div class="worktree-form-actions">
        <button
          type="button"
          class="worktree-cancel"
          disabled={pullRequestBusy}
          onclick={() => pullRequestDialog.close()}>Cancel</button
        >
        <button
          type="submit"
          class="worktree-create"
          disabled={pullRequestBusy || !pullRequestBase.trim() || !pullRequestTitle.trim()}
          >{pullRequestBusy ? 'Creating…' : 'Create pull request'}</button
        >
      </div>
    </form>{/if}
</dialog>
