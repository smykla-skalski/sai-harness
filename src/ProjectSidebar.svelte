<script lang="ts">
  import { tick } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import type { ProjectCatalog } from './lib/projects';
  import { ungroupedRepositories } from './lib/projects';

  type Props = {
    catalog: ProjectCatalog;
    directory: string;
    disabled: boolean;
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
    ) => Promise<void>;
    ondeleteworktree: (repository: string, path: string, branch: string) => Promise<void>;
  };

  let {
    catalog,
    directory,
    disabled,
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
  }: Props = $props();
  let creatingGroup = $state(false);
  let editingGroupID = $state<string | null>(null);
  let groupName = $state('');
  let menuGroupID = $state<string | null>(null);
  let menuRepository = $state<string | null>(null);
  let menuWorktree = $state<string | null>(null);
  let creatingWorktreeFor = $state<string | null>(null);
  let worktreeDialog: HTMLDialogElement;
  let worktreeNameInput = $state<HTMLInputElement>();
  let worktreeName = $state('');
  let worktreeDestination = $state<string | null>(null);
  let worktreeBase = $state('');
  let worktreeBusy = $state(false);
  let worktreeError = $state('');
  let ungrouped = $derived(ungroupedRepositories(catalog));

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

  function startRename(id: string, name: string) {
    editingGroupID = id;
    groupName = name;
    menuGroupID = null;
  }

  function cancelGroup() {
    creatingGroup = false;
    editingGroupID = null;
    groupName = '';
  }

  async function startWorktree(path: string) {
    creatingWorktreeFor = path;
    worktreeName = '';
    worktreeDestination = null;
    worktreeBase = '';
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
      );
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
</script>

<svelte:window
  onclick={(event) => {
    if (event.button === 0) menuWorktree = null;
  }}
/>
<section class="projects" aria-label="Projects and repositories">
  <div class="projects-heading">
    <span class="label">PROJECTS</span>
    <button
      class="project-control"
      aria-label="Add project group"
      title="Add project group"
      onclick={() => {
        creatingGroup = true;
        editingGroupID = null;
        groupName = '';
      }}>+ Group</button
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
      <input aria-label="New project group name" placeholder="Group name" bind:value={groupName} />
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
            <input aria-label={`Rename ${group.name}`} bind:value={groupName} />
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
                </div>
                {#if menuWorktree === worktree.path}<div class="project-menu worktree-menu">
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
              </div>
              {#if menuWorktree === worktree.path}<div class="project-menu worktree-menu">
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
