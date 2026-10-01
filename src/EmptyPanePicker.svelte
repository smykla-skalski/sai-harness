<script lang="ts">
  import { tick } from 'svelte';
  import type { AgentAvailability, AgentId } from './lib/acp';

  let {
    agents,
    focused,
    onselect,
  }: { agents: AgentAvailability[]; focused: boolean; onselect: (agent: AgentId) => void } =
    $props();
  let stage = $state<'kind' | 'agent'>('kind');
  let picker: HTMLElement;

  async function showAgents() {
    stage = 'agent';
    await tick();
    (
      picker.querySelector<HTMLButtonElement>('[data-agent-choice]:not(:disabled)') ??
      picker.querySelector<HTMLButtonElement>('.pane-picker-back')
    )?.focus();
  }

  async function showKinds() {
    stage = 'kind';
    await tick();
    picker.querySelector<HTMLButtonElement>('[data-pane-picker]')?.focus();
  }

  function keydown(event: KeyboardEvent) {
    if (
      !focused ||
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.isComposing ||
      !(event.target instanceof Element) ||
      event.target.closest('input, textarea, select, [contenteditable="true"]') ||
      document.querySelector('dialog[open]')
    )
      return;
    const pane = picker.closest('.pane-leaf');
    const targetPane = event.target.closest('.pane-leaf');
    if (targetPane && targetPane !== pane) return;
    if (stage === 'kind' && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      void showAgents();
    } else if (stage === 'agent' && event.key === 'Escape') {
      event.preventDefault();
      void showKinds();
    } else if (stage === 'agent' && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      const choices = [
        ...picker.querySelectorAll<HTMLButtonElement>('[data-agent-choice]:not(:disabled)'),
      ];
      if (!choices.length) return;
      event.preventDefault();
      const current = choices.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next =
        current < 0
          ? step > 0
            ? 0
            : choices.length - 1
          : (current + step + choices.length) % choices.length;
      choices[next]?.focus();
    } else if (
      stage === 'agent' &&
      event.key === 'Enter' &&
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.hasAttribute('data-agent-choice')
    ) {
      event.preventDefault();
      document.activeElement.click();
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="pane-picker" role="group" aria-label="Choose pane content" bind:this={picker}>
  {#if stage === 'kind'}
    <div class="pane-picker-intro">
      <span class="pane-picker-icon" aria-hidden="true">+</span>
      <h2>What would you like to open?</h2>
      <p>Choose what goes in this pane. You can decide later.</p>
    </div>
    <div class="pane-picker-choices">
      <button class="pane-picker-choice" data-pane-picker onclick={showAgents}>
        <span class="pane-picker-choice-icon" aria-hidden="true">✦</span>
        <span><strong>Agent</strong><small>Start a conversation</small></span>
        <kbd>A</kbd>
      </button>
      <button class="pane-picker-choice" disabled>
        <span class="pane-picker-choice-icon" aria-hidden="true">◎</span>
        <span><strong>Browser</strong><small>Coming soon</small></span>
        <kbd>B</kbd>
      </button>
      <button class="pane-picker-choice" disabled>
        <span class="pane-picker-choice-icon" aria-hidden="true">›_</span>
        <span><strong>Terminal</strong><small>Coming soon</small></span>
        <kbd>T</kbd>
      </button>
    </div>
  {:else}
    <div class="pane-picker-intro">
      <button class="pane-picker-back" onclick={showKinds}>← Back <kbd>Esc</kbd></button>
      <h2>Choose an agent</h2>
      <p>Use ↑ ↓ and Enter, or click an agent.</p>
    </div>
    <div class="pane-picker-choices" aria-label="Agents">
      {#each agents as agent (agent.id)}
        <button
          class="pane-picker-choice"
          data-agent-choice
          disabled={!agent.available}
          onclick={() => onselect(agent.id)}
        >
          <span class="pane-picker-choice-icon" aria-hidden="true">✦</span>
          <span
            ><strong>{agent.name}</strong><small
              >{agent.available ? 'New conversation' : (agent.reason ?? 'Unavailable')}</small
            ></span
          >
          <span class="pane-picker-chevron" aria-hidden="true">→</span>
        </button>
      {:else}
        <p class="pane-picker-empty">No agents found.</p>
      {/each}
    </div>
  {/if}
</div>
