<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '@smykla-skalski/sui';
  import type { FileDiffInfo } from '@opencode/client';
  import { parsePatch, patchUnavailableReason, type DiffAnnotation } from './lib/diff';

  interface Props {
    files: FileDiffInfo[];
    annotations: Record<string, DiffAnnotation>;
    selected: string | null;
    loading: boolean;
    error: string;
    onselect: (file: string) => void;
    onrefresh: () => void;
  }

  let { files, annotations, selected, loading, error, onselect, onrefresh }: Props = $props();
  let current = $derived(files.find((file) => file.file === selected));
  let lines = $derived(current ? parsePatch(current.patch) : null);
  let unavailable = $derived(current ? patchUnavailableReason(current.patch) : null);
  let patchScroll = $state<HTMLDivElement>();
  let previousFile: string | null = null;

  async function resetScroll(file: string | null) {
    await tick();
    if (selected === file && patchScroll) patchScroll.scrollTop = 0;
  }

  $effect(() => {
    if (selected === previousFile) return;
    previousFile = selected;
    const file = selected;
    void resetScroll(file);
  });
</script>

<aside class="diff-panel" aria-label="Session changes">
  <header class="diff-heading">
    <div>
      <p class="eyebrow">SESSION DIFF</p>
      <h2>Changes</h2>
    </div>
    <Button size="sm" variant="ghost" onclick={onrefresh} disabled={loading}
      >{loading ? 'Refreshing…' : 'Refresh'}</Button
    >
  </header>
  {#if error}<p class="diff-error" role="alert">{error}</p>{/if}
  <div class="diff-files" aria-label="Changed files">
    {#each files as file (file.file)}
      <button class:active={file.file === selected} onclick={() => onselect(file.file)}>
        <strong>{file.file}</strong><span>{file.status} · +{file.additions} −{file.deletions}</span>
        {#if annotations[file.file]?.drift.length}<small class="drift"
            >Outside {annotations[file.file].drift.join(', ')} step files</small
          >{/if}
        {#if annotations[file.file]?.unattributed}<small class="drift"
            >Edited without an active step</small
          >{/if}
        {#if annotations[file.file]?.steps.length}<small
            >Steps: {annotations[file.file].steps.join(', ')}</small
          >{/if}
      </button>
    {:else}
      <p class="diff-empty">{loading ? 'Loading changes…' : 'No session changes reported.'}</p>
    {/each}
  </div>
  <div class="diff-content">
    {#if current}
      <div class="diff-file-heading">
        <strong>{current.file}</strong><span
          >{current.status} · +{current.additions} −{current.deletions}</span
        >
      </div>
      {#if lines}
        <div
          class="patch-scroll"
          bind:this={patchScroll}
          role="region"
          aria-label={`Diff for ${current.file}`}
        >
          {#each lines as line, index (index)}<div
              class="diff-line"
              class:added={line.kind === 'added'}
              class:deleted={line.kind === 'deleted'}
              class:hunk={line.kind === 'hunk'}
            >
              <code>{line.text || ' '}</code>
            </div>{/each}
        </div>
      {:else}<p class="diff-fallback">
          {unavailable === 'large'
            ? 'This patch is too large to preview here. Open the file in your editor to inspect it.'
            : unavailable === 'binary'
              ? 'Binary change: no readable text patch is available.'
              : 'No text patch is available. This may be a binary or metadata-only change.'}
        </p>{/if}
    {:else if selected}<p class="diff-fallback">No session diff entry for {selected}.</p>
    {:else}<p class="diff-fallback">Select a changed file to inspect its patch.</p>{/if}
  </div>
</aside>

<style>
  .diff-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    background: var(--sui-surface);
  }
  .diff-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--shell-divider);
  }
  .eyebrow {
    margin: 0 0 3px;
    color: var(--sui-primary);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  .diff-error {
    margin: 10px 16px;
    color: var(--sui-danger);
    font-size: 12px;
  }
  .diff-files {
    max-height: 34%;
    overflow: auto;
    border-bottom: 1px solid var(--shell-divider);
  }
  .diff-files button {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding: 9px 16px;
    border: 0;
    border-bottom: 1px solid var(--shell-divider);
    background: transparent;
    color: var(--sui-foreground);
    text-align: left;
  }
  .diff-files button.active {
    background: var(--shell-selected);
  }
  .diff-files strong {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .diff-files span,
  .diff-files small {
    color: var(--sui-muted);
    font-size: 11px;
  }
  .diff-files .drift {
    color: var(--sui-danger);
  }
  .diff-empty,
  .diff-fallback {
    margin: 16px;
    color: var(--sui-muted);
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .diff-content {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  }
  .diff-file-heading {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--shell-divider);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .diff-file-heading span {
    flex: 0 0 auto;
    color: var(--sui-muted);
  }
  .patch-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    font-size: 11px;
    line-height: 1.5;
  }
  .diff-line {
    width: max-content;
    min-width: 100%;
    padding: 0 12px;
    white-space: pre;
  }
  .diff-line.added {
    background: rgba(37, 153, 103, 0.13);
  }
  .diff-line.deleted {
    background: rgba(213, 82, 82, 0.13);
  }
  .diff-line.hunk {
    background: var(--shell-selected);
    color: var(--shell-selected-ink);
  }
</style>
