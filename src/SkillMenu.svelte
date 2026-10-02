<script lang="ts">
  import type { SkillChoice } from './lib/skills';

  let {
    id,
    skills,
    selected,
    choose,
  }: {
    id: string;
    skills: SkillChoice[];
    selected: number;
    choose: (skill: SkillChoice) => void;
  } = $props();

  $effect(() => {
    if (!skills.length) return;
    document
      .getElementById(`${id}-option-${Math.min(selected, skills.length - 1)}`)
      ?.scrollIntoView({
        block: 'nearest',
      });
  });
</script>

{#if skills.length}
  <div {id} class="skill-menu" role="listbox" aria-label="Skills">
    {#each skills as skill, index (skill.name)}
      <button
        id={`${id}-option-${index}`}
        type="button"
        role="option"
        aria-selected={index === selected}
        onmousedown={(event) => event.preventDefault()}
        onclick={() => choose(skill)}
      >
        <strong>/{skill.name}</strong>
        {#if skill.description}<small>{skill.description}</small>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .skill-menu {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 20;
    max-height: 260px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--sui-border);
    border-radius: 8px;
    background: var(--sui-surface);
    box-shadow: 0 8px 24px #0005;
  }
  button {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 2px;
    padding: 7px 9px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  button[aria-selected='true'],
  button:hover {
    background: color-mix(in srgb, var(--sui-primary) 12%, var(--sui-surface));
  }
  small {
    opacity: 0.7;
  }
</style>
