import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('split agent panes', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-panes-e2e-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('splits in both directions, restores the worktree layout, and closes panes', async () => {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [] }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await expect($('.agent-launches button')).toBeDisplayed();
    await $('.agent-launches button').click();
    await browser.keys(['Meta', 'd']);
    await expect($('.pane-split.row')).toBeDisplayed();
    expect((await $$('.pane-leaf')).length).toBe(2);
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
    const focusedBefore = await $('.pane-leaf.focused').getAttribute('data-pane-id');
    await browser.keys('F6');
    const focusedAfter = await $('.pane-leaf.focused').getAttribute('data-pane-id');
    expect(focusedAfter).not.toBe(focusedBefore);

    await browser.refresh();
    await expect($('.pane-split.column')).toBeDisplayed();
    expect((await $$('.pane-leaf')).length).toBe(3);
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
  });
});
