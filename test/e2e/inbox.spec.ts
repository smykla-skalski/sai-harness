import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('pending requests across projects', () => {
  const first = mkdtempSync(join(tmpdir(), 'sail-inbox-first-'));
  const second = mkdtempSync(join(tmpdir(), 'sail-inbox-second-'));

  before(() => {
    execFileSync('git', ['init', '-q', first]);
    execFileSync('git', ['init', '-q', second]);
  });
  after(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });

  it('orders requests, answers inline, and opens the exact thread', async () => {
    const paths = [realpathSync(first), realpathSync(second)];
    await browser.execute(([one, two]) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.setItem('sai-directory', one);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [one, two], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.removeItem('sai-thread-attention');
      localStorage.removeItem('sai-inbox-seen');
      localStorage.setItem('sai-notifications-enabled', 'false');
    }, paths);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();

    await $('.agent-launches button').click();
    await $('.agent-composer textarea').waitForEnabled();
    await $('.agent-composer textarea').setValue('First request');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await $(`.project-repository-select[title="${paths[1]}"]`).click();
    await expect($('.agent-launches button')).toBeEnabled();
    await $('.agent-launches button').click();
    await $('.agent-composer textarea').waitForEnabled();
    await $('.agent-composer textarea').setValue('Second request');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await $(`.project-repository-select[title="${paths[0]}"]`).click();

    await $('[aria-label="Pending requests"]').click();
    const entries = await $$('.inbox-item');
    await expect(entries).toBeElementsArrayOfSize(2);
    await expect(entries[0]).toHaveText(expect.stringContaining(first.split('/').at(-1)!));
    await expect(entries[1]).toHaveText(expect.stringContaining(second.split('/').at(-1)!));
    await entries[0].$('.inbox-actions button').click();
    await expect($$('.inbox-item')).toBeElementsArrayOfSize(1);
    await $('.inbox-item .inbox-open').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => document.activeElement?.classList.contains('agent-permission')),
    );
    await $('.agent-permission button').click();
    await $('[aria-label="Pending requests"]').click();
    await expect($('.inbox-empty')).toHaveText('Nothing needs your input.');
  });
});
