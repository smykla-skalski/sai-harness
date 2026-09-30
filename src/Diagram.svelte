<script lang="ts">
  interface Props {
    source: string;
    dark: boolean;
    title?: string;
  }

  let { source, dark, title = 'Plan diagram' }: Props = $props();
  let imageUrl = $state('');
  let error = $state('');
  let generation = 0;

  $effect(() => {
    const current = ++generation;
    imageUrl = '';
    error = '';
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'neutral',
        });
        const rendered = await mermaid.render(
          `sai-plan-${current}-${Math.random().toString(36).slice(2)}`,
          source,
        );
        if (current === generation)
          imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`;
      } catch {
        if (current === generation) error = 'Diagram preview is unavailable.';
      }
    })();
  });
</script>

<div class="diagram" aria-label={title}>
  {#if imageUrl}
    <img src={imageUrl} alt={`${title}. Text version follows.`} />
  {:else if error}
    <p>{error}</p>
  {:else}
    <p>Rendering diagram…</p>
  {/if}
  <details class="diagram-source" open={!!error}>
    <summary>Read {title} as text</summary>
    <pre>{source}</pre>
  </details>
</div>

<style>
  .diagram {
    overflow: auto;
    padding: 16px;
    border: 1px solid var(--shell-divider);
    border-radius: 10px;
    background: var(--sui-surface);
  }
  img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }
  p {
    margin: 0;
    color: var(--sui-muted);
    font-size: 13px;
  }
  pre {
    overflow: auto;
    font-size: 12px;
    white-space: pre-wrap;
  }
  .diagram-source {
    margin-top: 12px;
    font-size: 12px;
  }
  summary {
    cursor: pointer;
  }
</style>
