<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import { invoke } from '@tauri-apps/api/core';
  import type { AgentAvailability } from './lib/acp';
  import type { ProjectCatalog, ProjectWorktree } from './lib/projects';
  import { ungroupedRepositories } from './lib/projects';
  import { getSetting, setSetting } from './lib/settings';

  export type PullRequestCheck = { name: string; state: string; url: string };
  type PullRequestChecks = { number: number; url: string; checks: PullRequestCheck[] };

  type Props = {
    catalog: ProjectCatalog;
    directory: string;
    disabled: boolean;
    agents: AgentAvailability[];
    openCodeAvailable: boolean;
    onselect: (path: string) => void;
    onaddrepository: (groupID: string | null) => void;
    onaddgroup: (name: string) => void;
    onrenamegroup: (id: string, name: string) => void;
    ondeletegroup: (id: string) => void;
    ontogglegroup: (id: string) => void;
    onmoverepository: (path: string, groupID: string | null) => void;
    onremoverepository: (path: string) => void;
    oncreateworktree: (
      path: string,
      name: string,
      destinationParent: string | null,
      baseRef: string | null,
      agent: string | null,
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

  let {
    catalog,
    directory,
    disabled,
    agents,
    openCodeAvailable,
    onselect,
    onaddrepository,
    onaddgroup,
    onrenamegroup,
    ondeletegroup,
    ontogglegroup,
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
  let menuGroupID = $state<string | null>(null);
  let menuRepository = $state<string | null>(null);
  let menuWorktree = $state<string | null>(null);
  let creatingWorktreeFor = $state<string | null>(null);
  let worktreeDialog: HTMLDialogElement;
  let worktreeNameInput = $state<HTMLInputElement>();
  let worktreeName = $state('');
  let worktreeDestination = $state<string | null>(null);
  let worktreeBase = $state('');
  let worktreeAgent = $state('');
  let worktreeBusy = $state(false);
  let worktreeError = $state('');
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

  function checkState(check: PullRequestCheck) {
    if (
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE'].includes(
        check.state,
      )
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
      const entries = Object.entries(catalog.worktrees).flatMap(([repository, worktrees]) =>
        worktrees.map((worktree) => ({ repository, worktree })),
      );
      const results = await Promise.allSettled(
        entries.map(({ repository, worktree }) =>
          invoke<PullRequestChecks | null>('pull_request_checks', {
            repository,
            worktree: worktree.path,
            branch: worktree.branch,
          }),
        ),
      );
      const next: Record<string, PullRequestChecks | null> = {};
      const errors: Record<string, string> = {};
      results.forEach((result, index) => {
        const path = entries[index].worktree.path;
        if (result.status === 'fulfilled') next[path] = result.value;
        else
          errors[path] =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
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
    menuGroupID = null;
    await tick();
    groupNameInput?.focus();
  }

  function cancelGroup() {
    creatingGroup = false;
    editingGroupID = null;
    groupName = '';
    void tick().then(() => addGroupButton?.focus());
  }

  async function startWorktree(path: string) {
    creatingWorktreeFor = path;
    worktreeName = '';
    worktreeDestination = null;
    worktreeBase = '';
    const savedAgent = getSetting('sai-worktree-agent') ?? '';
    worktreeAgent =
      (savedAgent === 'opencode' && openCodeAvailable) ||
      agents.some((agent) => agent.id === savedAgent && agent.available)
        ? savedAgent
        : '';
    worktreeError = '';
    menuRepository = null;
    await tick();
    worktreeDialog.showModal();
    worktreeNameInput?.focus();
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
    worktreeBusy = true;
    worktreeError = '';
    try {
      await oncreateworktree(
        path,
        worktreeName.trim(),
        worktreeDestination,
        worktreeBase.trim() || null,
        worktreeAgent || null,
      );
      setSetting('sai-worktree-agent', worktreeAgent);
      worktreeDialog.close();
    } catch (cause) {
      worktreeError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      worktreeBusy = false;
    }
  }

  function closeWorktreeDialog() {
    if (!worktreeBusy) worktreeDialog.close();
  }

  async function startPullRequest(repository: string, worktree: ProjectWorktree) {
    creatingPullRequestFor = { repository, worktree };
    const base = worktree.base?.replace(/^origin\//, '');
    pullRequestBase = base && base !== 'HEAD' ? base : 'main';
    pullRequestTitle = worktree.branch.replace(/[-_]+/g, ' ');
    pullRequestBody = '';
    pullRequestDraft = false;
    pullRequestError = '';
    menuWorktree = null;
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
    if (event.button === 0) menuWorktree = null;
  }}
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
        aria-label={`Pull request #${pr.number} checks ${overallState(pr.checks)}`}
        title={`Checks ${overallState(pr.checks)}`}
      ></span>
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
          </form>{:else}<div class="project-group-heading">
            <button
              class="project-group-toggle"
              aria-expanded={!group.collapsed}
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
              aria-expanded={menuGroupID === group.id}
              onclick={() => (menuGroupID = menuGroupID === group.id ? null : group.id)}>⋯</button
            >
          </div>{/if}
        {#if menuGroupID === group.id}<div class="project-menu">
            <button onclick={() => startRename(group.id, group.name)}>Rename group</button>
            <button
              onclick={() => {
                ondeletegroup(group.id);
                menuGroupID = null;
              }}>Delete group</button
            >
          </div>{/if}
        {#if !group.collapsed}
          {#each group.repositories as path (path)}
            <div class="project-repository">
              <div class:active={path === directory} class="project-repository-row">
                <button
                  class="project-repository-select"
                  aria-current={path === directory ? 'page' : undefined}
                  title={path}
                  onclick={() => onselect(path)}
                  {disabled}
                  ><span aria-hidden="true">⌁</span><span>{repositoryName(path)}</span></button
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
                  aria-expanded={menuRepository === path}
                  onclick={() => (menuRepository = menuRepository === path ? null : path)}>⋯</button
                >
              </div>
              {#if menuRepository === path}<div class="project-menu">
                  <label
                    >Move to <select
                      aria-label={`Move ${repositoryName(path)} to group`}
                      value={group.id}
                      onchange={(event) => {
                        onmoverepository(path, event.currentTarget.value || null);
                        menuRepository = null;
                      }}
                    >
                      <option value="">Ungrouped</option>
                      {#each catalog.groups as destination (destination.id)}<option
                          value={destination.id}>{destination.name}</option
                        >{/each}
                    </select></label
                  >
                  <button
                    onclick={() => {
                      onremoverepository(path);
                      menuRepository = null;
                    }}
                    disabled={path === directory ||
                      (catalog.worktrees[path] ?? []).some(
                        (worktree) => worktree.path === directory,
                      )}
                    title={path === directory ||
                    (catalog.worktrees[path] ?? []).some((worktree) => worktree.path === directory)
                      ? 'Switch repositories before removing this one'
                      : 'Remove from sidebar'}>Remove from sidebar</button
                  >
                </div>{/if}
              {#each catalog.worktrees[path] ?? [] as worktree (worktree.path)}<div
                  class:active={worktree.path === directory}
                  class="project-worktree-row"
                >
                  <button
                    class="project-worktree-select"
                    aria-current={worktree.path === directory ? 'page' : undefined}
                    title={worktree.path}
                    {disabled}
                    onmousedown={(event) => {
                      if (event.button === 2) menuWorktree = worktree.path;
                    }}
                    oncontextmenu={(event) => {
                      event.preventDefault();
                      menuWorktree = worktree.path;
                    }}
                    onclick={() => onselect(worktree.path)}
                    ><span aria-hidden="true">⑂</span><span>{worktree.branch}</span></button
                  >
                  {@render checkBadge(worktree)}
                  <button
                    class="project-icon-button"
                    aria-label={`Manage worktree ${worktree.branch}`}
                    aria-expanded={menuWorktree === worktree.path}
                    onclick={(event) => {
                      event.stopPropagation();
                      menuWorktree = menuWorktree === worktree.path ? null : worktree.path;
                    }}>⋯</button
                  >
                </div>
                {@render checkFailures(path, worktree)}
                {#if menuWorktree === worktree.path}<div class="project-menu worktree-menu">
                    {#if !currentPullRequest(worktree)}<button
                        aria-label={`Create pull request for ${worktree.branch}`}
                        onclick={() => startPullRequest(path, worktree)}
                        >Create pull request…</button
                      >{/if}
                    <button
                      aria-label={`Delete worktree ${worktree.branch}`}
                      onclick={() => {
                        menuWorktree = null;
                        void ondeleteworktree(path, worktree.path, worktree.branch);
                      }}>Delete worktree…</button
                    >
                  </div>{/if}{/each}
            </div>
          {:else}<p class="project-empty">No repositories</p>{/each}
        {/if}
      </div>
    {/each}
    {#if ungrouped.length || !catalog.groups.length}<div class="project-group">
        <div class="project-group-heading"><span class="project-group-label">Ungrouped</span></div>
        {#each ungrouped as path (path)}
          <div class="project-repository">
            <div class:active={path === directory} class="project-repository-row">
              <button
                class="project-repository-select"
                aria-current={path === directory ? 'page' : undefined}
                title={path}
                onclick={() => onselect(path)}
                {disabled}
                ><span aria-hidden="true">⌁</span><span>{repositoryName(path)}</span></button
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
                aria-expanded={menuRepository === path}
                onclick={() => (menuRepository = menuRepository === path ? null : path)}>⋯</button
              >
            </div>
            {#if menuRepository === path}<div class="project-menu">
                <label
                  >Move to <select
                    aria-label={`Move ${repositoryName(path)} to group`}
                    value=""
                    onchange={(event) => {
                      onmoverepository(path, event.currentTarget.value || null);
                      menuRepository = null;
                    }}
                  >
                    <option value="">Ungrouped</option>
                    {#each catalog.groups as destination (destination.id)}<option
                        value={destination.id}>{destination.name}</option
                      >{/each}
                  </select></label
                >
                <button
                  onclick={() => {
                    onremoverepository(path);
                    menuRepository = null;
                  }}
                  disabled={path === directory ||
                    (catalog.worktrees[path] ?? []).some((worktree) => worktree.path === directory)}
                  title={path === directory ||
                  (catalog.worktrees[path] ?? []).some((worktree) => worktree.path === directory)
                    ? 'Switch repositories before removing this one'
                    : 'Remove from sidebar'}>Remove from sidebar</button
                >
              </div>{/if}
            {#each catalog.worktrees[path] ?? [] as worktree (worktree.path)}<div
                class:active={worktree.path === directory}
                class="project-worktree-row"
              >
                <button
                  class="project-worktree-select"
                  aria-current={worktree.path === directory ? 'page' : undefined}
                  title={worktree.path}
                  {disabled}
                  onmousedown={(event) => {
                    if (event.button === 2) menuWorktree = worktree.path;
                  }}
                  oncontextmenu={(event) => {
                    event.preventDefault();
                    menuWorktree = worktree.path;
                  }}
                  onclick={() => onselect(worktree.path)}
                  ><span aria-hidden="true">⑂</span><span>{worktree.branch}</span></button
                >
                {@render checkBadge(worktree)}
                <button
                  class="project-icon-button"
                  aria-label={`Manage worktree ${worktree.branch}`}
                  aria-expanded={menuWorktree === worktree.path}
                  onclick={(event) => {
                    event.stopPropagation();
                    menuWorktree = menuWorktree === worktree.path ? null : worktree.path;
                  }}>⋯</button
                >
              </div>
              {@render checkFailures(path, worktree)}
              {#if menuWorktree === worktree.path}<div class="project-menu worktree-menu">
                  {#if !currentPullRequest(worktree)}<button
                      aria-label={`Create pull request for ${worktree.branch}`}
                      onclick={() => startPullRequest(path, worktree)}>Create pull request…</button
                    >{/if}
                  <button
                    aria-label={`Delete worktree ${worktree.branch}`}
                    onclick={() => {
                      menuWorktree = null;
                      void ondeleteworktree(path, worktree.path, worktree.branch);
                    }}>Delete worktree…</button
                  >
                </div>{/if}{/each}
          </div>
        {:else}<p class="project-empty">Add a repository to switch between projects.</p>{/each}
      </div>{/if}
  </nav>
</section>

<dialog
  class="worktree-dialog"
  aria-labelledby="worktree-dialog-title"
  bind:this={worktreeDialog}
  oncancel={(event) => {
    if (worktreeBusy) event.preventDefault();
  }}
  onclose={() => (creatingWorktreeFor = null)}
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
      <label
        >Start with agent
        <select
          aria-label="Agent for new worktree"
          bind:value={worktreeAgent}
          disabled={worktreeBusy}
        >
          <option value="">Choose after creation</option>
          <option value="opencode" disabled={!openCodeAvailable}>OpenCode</option>
          {#each agents as agent (agent.id)}<option value={agent.id} disabled={!agent.available}
              >{agent.name}</option
            >{/each}
        </select>
      </label>
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
          disabled={worktreeBusy || !worktreeName.trim()}
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
