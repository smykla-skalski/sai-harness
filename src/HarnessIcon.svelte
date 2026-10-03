<script lang="ts">
  import claude from './assets/harness/claude.svg';
  import codex from './assets/harness/codex.svg';
  import opencode from './assets/harness/opencode.svg';

  let { agent, size = 16 }: { agent: string; size?: number } = $props();
  const icons: Record<string, string> = { claude, codex, opencode };
  let icon = $derived(icons[agent]);
</script>

{#if icon}
  <span
    class={`harness-icon ${agent}`}
    style={`--harness-mask: url("${icon}"); --harness-size: ${size}px`}
    aria-hidden="true"
  ></span>
{/if}

<style>
  .harness-icon {
    display: inline-block;
    flex: none;
    width: var(--harness-size);
    height: var(--harness-size);
    background: currentColor;
    -webkit-mask: var(--harness-mask) center / contain no-repeat;
    mask: var(--harness-mask) center / contain no-repeat;
    vertical-align: -0.16em;
  }
  .claude {
    color: #a64b30;
  }
  .codex {
    color: #08745e;
  }
  .opencode {
    color: #514b9c;
  }
  :global([data-sui-theme='dark']) .claude {
    color: #e69c7e;
  }
  :global([data-sui-theme='dark']) .codex {
    color: #72d9b8;
  }
  :global([data-sui-theme='dark']) .opencode {
    color: #bbb3ef;
  }
</style>
