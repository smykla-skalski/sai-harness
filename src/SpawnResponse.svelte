<script lang="ts">
  import Markdown from './Markdown.svelte';
  import type { SpawnReceipt } from './lib/agent-results';

  let { receipt }: { receipt: SpawnReceipt } = $props();
  const name = $derived(
    receipt.provider === 'opencode'
      ? 'OpenCode'
      : receipt.provider === 'codex'
        ? 'Codex'
        : 'Claude',
  );
</script>

<article class="message assistant-message spawn-response" aria-label={`${name} subagent response`}>
  <div class="avatar agent-avatar">↳</div>
  <div class="message-body">
    <div class="message-author">{name} · subagent · {receipt.state}</div>
    {#if receipt.result}<Markdown source={receipt.result} />{/if}
    {#if receipt.error}<p class="spawn-error">{receipt.error}</p>{/if}
    {#if !receipt.result && !receipt.error}<p>{receipt.state}</p>{/if}
  </div>
</article>

<style>
  .spawn-response {
    width: 100%;
  }
  .spawn-error {
    color: var(--sui-danger);
  }
</style>
