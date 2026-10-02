import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('empty default worktree', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-default-pane-'));
  const secondRepository = mkdtempSync(join(tmpdir(), 'sail-default-pane-second-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['init', '-q', secondRepository]);
  });
  after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(secondRepository, { recursive: true, force: true });
  });

  it('opens the pane chooser and keeps chosen content', async () => {
    const path = realpathSync(repository);
    const other = realpathSync(secondRepository);
    await browser.execute(
      ([selectedPath, otherPath]) => {
        sessionStorage.removeItem('sail-e2e-settings');
        localStorage.setItem('sai-directory', selectedPath);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [selectedPath, otherPath], groups: [], worktrees: {} }),
        );
        localStorage.removeItem('sai-pane-layouts');
        localStorage.removeItem(`sai-session:${selectedPath}`);
        localStorage.removeItem(`sai-session:${otherPath}`);
        localStorage.removeItem(`sai-main-pane-empty:${selectedPath}`);
        localStorage.removeItem(`sai-main-pane-empty:${otherPath}`);
      },
      [path, other],
    );
    await browser.refresh();

    const defaultWorktree = $(`.project-default-worktree-select[title="${path}"]`);
    await defaultWorktree.click();
    await expect($('.pane-leaf.focused [aria-label="Choose pane content"]')).toBeDisplayed();
    try {
      await expect($('.pane-leaf.focused [data-pane-picker]')).toBeFocused();
    } catch (cause) {
      console.error(
        'Default worktree focus diagnostic',
        await browser.execute(() => ({
          active: document.activeElement?.outerHTML,
          picker: document.querySelector('.pane-leaf.focused .pane-picker')?.outerHTML,
          focus: document.querySelector('.pane-leaf.focused')?.outerHTML.slice(0, 500),
        })),
      );
      throw cause;
    }

    await browser.keys('a');
    await expect($('.pane-picker-intro h2')).toHaveText('Choose an agent');
    await browser.keys('Escape');
    await expect($('.pane-picker-intro h2')).toHaveText('What would you like to open?');

    await $('.pane-picker-choices .pane-picker-choice:nth-child(2)').click();
    await expect($('.pane-leaf[aria-label="Browser pane"] .browser-pane')).toBeDisplayed();
    await browser.refresh();
    await expect($('.browser-pane')).toBeDisplayed();
    await defaultWorktree.click();
    await expect($('.browser-pane')).toBeDisplayed();
    await expect($('.pane-picker')).not.toExist();

    await $(`.project-default-worktree-select[title="${other}"]`).click();
    await expect($('.pane-leaf.focused [aria-label="Choose pane content"]')).toBeDisplayed();
    await $('.pane-picker-choices .pane-picker-choice:nth-child(3)').click();
    await expect($('.pane-leaf[aria-label="Terminal pane"] .terminal-pane')).toBeDisplayed();
    await $(`.project-default-worktree-select[title="${path}"]`).click();
    await expect($('.browser-pane')).toBeDisplayed();
    await $(`.project-default-worktree-select[title="${other}"]`).click();
    await expect($('.terminal-pane')).toBeDisplayed();

    await $('[aria-label="Close main pane"]').click();
    await expect($('.pane-picker')).toBeDisplayed();
    await $('.pane-picker-choices .pane-picker-choice:nth-child(2)').click();
    await expect($('.pane-leaf[aria-label="Browser pane"] .browser-pane')).toBeDisplayed();
    await $('.agent-launches button').click();
    await expect($('.agent-conversation')).toBeDisplayed();
    await expect($('.browser-pane')).not.toExist();
    await browser.keys(['Meta', 'w']);
    await expect($('.pane-picker')).toBeDisplayed();
    await $(`.project-default-worktree-select[title="${path}"]`).click();
    await expect($('.browser-pane')).toBeDisplayed();
    await $(`.project-default-worktree-select[title="${other}"]`).click();
    await expect($('.pane-picker')).toBeDisplayed();
    await browser.refresh();
    await expect($('.pane-picker')).toBeDisplayed();
    await $('[data-pane-picker]').click();
    await $('[data-agent-choice]:not([disabled])').click();
    await expect($('.agent-conversation')).toBeDisplayed();
  });

  it('restores terminals in two default worktrees', async () => {
    const path = realpathSync(repository);
    const other = realpathSync(secondRepository);
    await browser.execute(
      ([selectedPath, otherPath]) => {
        const terminal = { id: 'main', agent: null, thread: null, kind: 'terminal' };
        localStorage.setItem('sai-directory', selectedPath);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [selectedPath, otherPath], groups: [], worktrees: {} }),
        );
        localStorage.setItem(
          'sai-pane-layouts',
          JSON.stringify({ [selectedPath]: terminal, [otherPath]: terminal }),
        );
        localStorage.removeItem(`sai-session:${selectedPath}`);
        localStorage.removeItem(`sai-session:${otherPath}`);
        localStorage.removeItem(`sai-main-pane-empty:${selectedPath}`);
        localStorage.removeItem(`sai-main-pane-empty:${otherPath}`);
      },
      [path, other],
    );
    await browser.refresh();
    await expect($('.terminal-pane')).toBeDisplayed();
    await expect($('.pane-picker')).not.toExist();
    await $(`.project-default-worktree-select[title="${other}"]`).click();
    try {
      await expect($('.terminal-pane')).toBeDisplayed();
    } catch (cause) {
      console.error(
        'Main Terminal restore diagnostic',
        await browser.execute(() => ({
          directory: localStorage.getItem('sai-directory'),
          layouts: localStorage.getItem('sai-pane-layouts'),
          main: document.querySelector('[data-pane-id="main"]')?.outerHTML.slice(0, 1000),
        })),
      );
      throw cause;
    }
    await browser.pause(300);
    await expect($('.terminal-pane [role="alert"]')).not.toExist();
  });
});
