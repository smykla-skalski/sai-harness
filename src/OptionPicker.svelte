<script lang="ts">
  import { tick } from 'svelte';

  interface Choice {
    value: string;
    name: string;
  }

  interface Props {
    label: string;
    value?: string;
    options: Choice[];
    open: boolean;
    disabled?: boolean;
    loading?: boolean;
    onopen: () => void;
    onclose: () => void;
    onchoose: (value: string) => void;
  }

  let {
    label,
    value,
    options,
    open,
    disabled = false,
    loading = false,
    onopen,
    onclose,
    onchoose,
  }: Props = $props();
  let menu = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let active = $state(0);

  $effect(() => {
    if (!open) return;
    active = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    void tick().then(() => menu?.focus());
  });

  $effect(() => {
    if (open && menu) {
      const index = active;
      void tick().then(() =>
        menu?.querySelectorAll('button')[index]?.scrollIntoView({ block: 'nearest' }),
      );
    }
  });

  function close() {
    onclose();
    void tick().then(() => trigger?.focus());
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length)
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    } else if (event.key === 'Enter' && options[active]) {
      event.preventDefault();
      onchoose(options[active].value);
      close();
    }
  }
</script>

<div class="option-picker">
  <button
    type="button"
    class="option-trigger"
    bind:this={trigger}
    aria-label={`Choose ${label.toLowerCase()}`}
    aria-expanded={open}
    {disabled}
    onclick={onopen}
    >{label}: {options.find((option) => option.value === value)?.name ?? value ?? 'Choose'} ▾</button
  >
  {#if open}
    <div
      class="option-menu"
      role="listbox"
      aria-label={label}
      tabindex="-1"
      bind:this={menu}
      onkeydown={keydown}
    >
      {#if loading}
        <div class="option-empty">Loading…</div>
      {:else if !options.length}
        <div class="option-empty">No choices available for this model or agent.</div>
      {:else}
        {#each options as option, index (option.value)}
          <button
            type="button"
            role="option"
            aria-selected={option.value === value}
            class:active={index === active}
            onclick={() => {
              onchoose(option.value);
              close();
            }}>{option.name}</button
          >
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .option-picker {
    position: relative;
  }
  .option-trigger {
    padding: 5px 8px;
    border: 1px solid var(--border, var(--shell-divider));
    border-radius: 6px;
    color: inherit;
    background: var(--sui-surface);
    font-size: 12px;
  }
  .option-menu {
    position: absolute;
    bottom: calc(100% + 5px);
    left: 0;
    z-index: 20;
    min-width: 210px;
    max-height: 260px;
    overflow: auto;
    padding: 4px;
    border: 1px solid var(--border, var(--shell-divider));
    border-radius: 8px;
    background: var(--sui-surface);
    box-shadow: 0 8px 24px #0002;
  }
  .option-menu button {
    display: block;
    width: 100%;
    padding: 8px;
    border: 0;
    border-radius: 5px;
    color: inherit;
    background: transparent;
    text-align: left;
  }
  .option-menu button.active,
  .option-menu button:hover {
    background: var(--shell-selected);
  }
  .option-empty {
    padding: 8px;
    color: var(--sui-muted);
    font-size: 12px;
  }
</style>
