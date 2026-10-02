<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { tick } from 'svelte';

  type PickerEntry = { name: string; path: string; isDirectory: boolean };
  type PickerDirectory = { path: string; parent: string | null; entries: PickerEntry[] };

  let {
    open,
    title,
    mode,
    initialPath,
    onselect,
    oncancel,
  }: {
    open: boolean;
    title: string;
    mode: 'directory' | 'files';
    initialPath?: string;
    onselect: (paths: string[]) => void;
    oncancel: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  const headingID = `path-picker-title-${crypto.randomUUID()}`;
  let location = $state('');
  let listing = $state<PickerDirectory | null>(null);
  let selected = $state<string[]>([]);
  let loading = $state(false);
  let error = $state('');
  let generation = 0;
  let visibleEntries = $derived(
    listing?.entries.filter((entry) => mode === 'files' || entry.isDirectory) ?? [],
  );

  async function browse(path?: string) {
    const current = ++generation;
    loading = true;
    error = '';
    try {
      const result = await invoke<PickerDirectory>('list_picker_directory', { path });
      if (current !== generation) return;
      listing = result;
      location = result.path;
    } catch (cause) {
      if (current === generation) error = String(cause);
    } finally {
      if (current === generation) loading = false;
    }
  }

  $effect(() => {
    if (open) {
      selected = [];
      listing = null;
      void tick().then(() => {
        if (!dialog.open) dialog.showModal();
        void browse(initialPath);
        return undefined;
      });
    } else {
      ++generation;
      if (dialog?.open) dialog.close();
    }
  });

  function toggle(path: string) {
    selected = selected.includes(path)
      ? selected.filter((item) => item !== path)
      : [...selected, path];
  }
</script>

<dialog
  class="commands-dialog path-picker-dialog"
  bind:this={dialog}
  aria-labelledby={headingID}
  oncancel={(event) => {
    event.preventDefault();
    oncancel();
  }}
>
  <div class="path-picker-heading">
    <h2 id={headingID}>{title}</h2>
    <button type="button" aria-label="Close picker" onclick={oncancel}>×</button>
  </div>
  <form
    class="path-picker-location"
    onsubmit={(event) => {
      event.preventDefault();
      void browse(location);
    }}
  >
    <button
      type="button"
      aria-label="Parent folder"
      disabled={!listing?.parent || loading}
      onclick={() => void browse(listing?.parent ?? undefined)}>↑</button
    >
    <input aria-label="Folder path" bind:value={location} placeholder="Folder path" />
    <button type="submit" disabled={loading}>Go</button>
  </form>
  {#if error}<p class="path-picker-error" role="alert">{error}</p>{/if}
  <div class="path-picker-list" role="list" aria-label="Folder contents">
    {#if loading}<p class="path-picker-empty">Loading…</p>
    {:else if !visibleEntries.length}<p class="path-picker-empty">
        {mode === 'files' ? 'This folder is empty.' : 'No subfolders here.'}
      </p>
    {:else}
      {#each visibleEntries as entry (entry.path)}
        {#if entry.isDirectory}
          <button
            type="button"
            class="path-picker-entry"
            onclick={() => void browse(entry.path)}
            title={entry.path}><span aria-hidden="true">▸</span>{entry.name}</button
          >
        {:else if mode === 'files'}
          <button
            type="button"
            class="path-picker-entry"
            class:selected={selected.includes(entry.path)}
            aria-pressed={selected.includes(entry.path)}
            onclick={() => toggle(entry.path)}
            title={entry.path}
            ><span aria-hidden="true">{selected.includes(entry.path) ? '✓' : '·'}</span
            >{entry.name}</button
          >
        {/if}
      {/each}
    {/if}
  </div>
  <div class="path-picker-actions">
    {#if mode === 'files'}<span>{selected.length} selected</span>{:else}<span
        >{listing?.path ?? ''}</span
      >{/if}
    <button type="button" onclick={oncancel}>Cancel</button>
    <button
      type="button"
      class="confirmation-primary"
      disabled={loading || (mode === 'files' ? !selected.length : !listing)}
      onclick={() => onselect(mode === 'files' ? selected : listing ? [listing.path] : [])}
      >{mode === 'files' ? 'Attach files' : 'Choose folder'}</button
    >
  </div>
</dialog>
