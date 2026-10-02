import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await browser.saveScreenshot(join(output, `${name}.png`));
}

describe('split agent panes', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-panes-e2e-'));
  const worktree = mkdtempSync(join(tmpdir(), 'sail-panes-worktree-e2e-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'baseline',
    ]);
    rmSync(worktree, { recursive: true });
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', '-b', 'pane-test', worktree]);
  });
  after(() => {
    execFileSync('git', ['-C', repository, 'worktree', 'remove', '--force', worktree]);
    rmSync(repository, { recursive: true, force: true });
  });

  it('splits in both directions, restores the worktree layout, and closes panes', async () => {
    await browser.execute(
      (path, worktreePath) => {
        sessionStorage.removeItem('sail-e2e-settings');
        localStorage.setItem('sai-directory', path);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [path],
            groups: [],
            worktrees: { [path]: [{ path: worktreePath, branch: 'pane-test' }] },
          }),
        );
      },
      realpathSync(repository),
      realpathSync(worktree),
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeDisplayed();
    await $('.agent-launches button').click();
    await browser.keys(['Meta', 'd']);
    await expect($('.pane-split.row')).toBeDisplayed();
    expect((await $$('.pane-leaf')).length).toBe(2);
    await expect($('.pane-leaf.focused [data-pane-picker]')).toBeFocused();
    await browser.execute(() => document.querySelector<HTMLElement>('.sidebar')?.focus());
    await browser.keys('a');
    await expect($('.pane-leaf.focused [data-agent-choice]:not([disabled])')).toBeFocused();
    await browser.keys('ArrowDown');
    await expect($('.pane-leaf.focused [data-agent-choice]:last-child')).toBeFocused();
    await browser.keys('ArrowUp');
    await expect($('.pane-leaf.focused [data-agent-choice]:first-child')).toBeFocused();
    await browser.keys('Escape');
    await browser.execute(() => {
      const target = document.activeElement!;
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }),
      );
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    await expect($('.pane-leaf.focused [data-agent-choice]:last-child')).toBeFocused();
    await browser.keys('ArrowUp');
    await expect($('.pane-leaf.focused [data-agent-choice]:first-child')).toBeFocused();
    await $('.pane-leaf.focused .pane-picker-intro h2').click();
    await browser.keys('ArrowDown');
    await expect($('.pane-leaf.focused [data-agent-choice]:last-child')).toBeFocused();
    await browser.keys('ArrowUp');
    await expect($('.pane-leaf.focused [data-agent-choice]:first-child')).toBeFocused();
    await browser.execute(() => document.querySelector<HTMLElement>('.sidebar')?.focus());
    await browser.keys('ArrowUp');
    await expect($('.pane-leaf.focused [data-agent-choice]:last-child')).toBeFocused();
    await browser.keys('ArrowDown');
    await expect($('.pane-leaf.focused [data-agent-choice]:first-child')).toBeFocused();
    await browser.keys('Enter');
    await expect($('.pane-leaf.focused textarea[data-pane-prompt]')).toBeFocused();
    const header = await browser.execute(() => {
      const actions = document.querySelector<HTMLElement>('.topbar-actions')!;
      return {
        right: actions.getBoundingClientRect().right,
        scrollWidth: actions.scrollWidth,
        clientWidth: actions.clientWidth,
        viewport: innerWidth,
      };
    });
    expect(header.right).toBeLessThanOrEqual(header.viewport + 1);
    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
    await capture('desktop-agent-two-panes');
    await $('.pane-divider').click();
    await browser.keys('ArrowRight');
    const ratio = await browser.execute((path) => {
      const layouts = JSON.parse(localStorage.getItem('sai-pane-layouts') ?? '{}');
      return layouts[path]?.ratio;
    }, realpathSync(repository));
    expect(ratio).toBeGreaterThan(0.5);
    await browser.keys(['Meta', 'Shift', 'd']);
    await expect($('.pane-split.column')).toBeDisplayed();
    expect((await $$('.pane-leaf')).length).toBe(3);
    await expect($('.pane-leaf.focused [data-pane-picker]')).toBeFocused();
    await browser.keys('a');
    await browser.keys('Enter');
    await capture('desktop-agent-three-panes');
    const focusedBefore = await $('.pane-leaf.focused').getAttribute('data-pane-id');
    await browser.keys('F6');
    const focusedAfter = await $('.pane-leaf.focused').getAttribute('data-pane-id');
    expect(focusedAfter).not.toBe(focusedBefore);
    await expect($('.pane-leaf.focused textarea[data-pane-prompt]')).toBeFocused();

    await browser.refresh();
    await expect($('.pane-split.column')).toBeDisplayed();
    expect((await $$('.pane-leaf')).length).toBe(3);
    await capture('desktop-agent-restored-panes');
    await $(`.project-worktree-select[title="${realpathSync(worktree)}"]`).click();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 1);
    await expect($('.agent-launches button')).toBeDisplayed();
    await $('.agent-launches button').click();
    await browser.keys(['Meta', 'd']);
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 2);
    await $(`.project-repository-select[title="${realpathSync(repository)}"]`).click();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 3);
    await $(`.project-worktree-select[title="${realpathSync(worktree)}"]`).click();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 2);
    await $(`.project-repository-select[title="${realpathSync(repository)}"]`).click();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 3);
    await $('button[aria-label="Close pane"]').click();
    expect((await $$('.pane-leaf')).length).toBe(2);
    await $('button[aria-label="Close pane"]').click();
    expect((await $$('.pane-leaf')).length).toBe(1);
    await expect($('.workspace')).toBeDisplayed();

    await browser.keys(['Meta', 'd']);
    await $('button[aria-label="Close main pane"]').click();
    await $('button[aria-label="Close pane"]').click();
    await browser.refresh();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    await browser.keys(['Meta', 'w']);
    await expect($('.agent-header')).not.toExist();
    await expect($('.workspace')).toBeDisplayed();
  });
});
