<script lang="ts">
  import Markdown from './Markdown.svelte';
  import type { SpawnReceipt } from './lib/agent-results';
  import { receiptIsSettled } from './lib/agent-results';

  let { receipts }: { receipts: SpawnReceipt[] } = $props();
  const active = $derived(receipts.filter((receipt) => !receiptIsSettled(receipt.state)));

  function label(receipt: SpawnReceipt): string {
    return receipt.provider === 'opencode'
      ? 'OpenCode'
      : receipt.provider === 'codex'
        ? 'Codex'
        : 'Claude';
  }
</script>

{#if active.length}
  <section class="spawn-activity" aria-label="Running subagents">
    <h2>Subagents ({active.length})</h2>
    {#each active as receipt (receipt.receiptId)}
      <div class="spawn-active" role="status">
        <div class="spawn-heading">
          <strong>{label(receipt)}</strong>
          <span>{receipt.state}</span>
        </div>
        {#if receipt.prompt}<p class="spawn-prompt">{receipt.prompt}</p>{/if}
        {#if receipt.activity}<p class="spawn-activity-line">{receipt.activity}</p>{/if}
        {#if receipt.result}<div class="spawn-output">
            <Markdown source={receipt.result} />
          </div>{/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .spawn-activity {
    margin: 12px 0 16px 42px;
  }
  .spawn-activity h2 {
    margin: 0 0 8px;
    font-size: 0.85rem;
  }
  .spawn-active {
    margin-bottom: 8px;
    padding: 10px 12px;
    border: 1px solid var(--sui-primary);
    border-radius: 8px;
  }
  .spawn-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    text-transform: capitalize;
  }
  .spawn-heading span,
  .spawn-prompt {
    color: var(--sui-muted);
  }
  .spawn-activity-line {
    margin: 6px 0;
  }
  .spawn-prompt {
    margin: 6px 0;
    overflow-wrap: anywhere;
  }
  .spawn-output {
    max-height: 240px;
    overflow: auto;
  }
</style>
