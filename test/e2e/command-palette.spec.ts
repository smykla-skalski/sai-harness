import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('command palette', () => {
  const first = mkdtempSync(join(tmpdir(), 'sail-palette-first-'));
  const second = mkdtempSync(join(tmpdir(), 'sail-palette-second-'));

  before(() => {
    execFileSync('git', ['init', '-q', first]);
    execFileSync('git', ['init', '-q', second]);
  });
  after(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });

  it('jumps to the newest thread and starts an agent in an empty project', async () => {
    const firstPath = realpathSync(first);
    const secondPath = realpathSync(second);
    await browser.execute(
      (a, b) => {
        sessionStorage.removeItem('sail-e2e-settings');
        localStorage.setItem('sai-directory', a);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [a, b], groups: [], worktrees: {} }),
        );
        localStorage.setItem(
          'sail-agent-threads',
          JSON.stringify([
            { agent: 'claude', directory: b, sessionId: 'old', title: 'Old thread', updated: 1 },
            { agent: 'claude', directory: b, sessionId: 'new', title: 'Newest thread', updated: 2 },
            {
              agent: 'ghost',
              directory: b,
              sessionId: 'ghost',
              title: 'Unavailable thread',
              updated: 3,
            },
          ]),
        );
      },
      firstPath,
      secondPath,
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeDisplayed();

    await browser.keys(['Meta', 'k']);
    await expect($('.command-palette[open]')).toBeDisplayed();
    await expect($('[aria-label="Search projects, worktrees, and threads"]')).toBeFocused();
    await $('[aria-label="Search projects, worktrees, and threads"]').setValue(
      secondPath.split('/').at(-1)!,
    );
    await browser.keys('Enter');
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === secondPath,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Newest thread'));

    await browser.keys(['Meta', 'k']);
    await $('[aria-label="Search projects, worktrees, and threads"]').setValue(
      `claude ${firstPath.split('/').at(-1)}`,
    );
    await browser.keys('Enter');
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === firstPath,
    );
    await expect($('textarea[aria-label="Message Claude"]')).toBeFocused();

    await browser.keys(['Meta', 'k']);
    await $('[aria-label="Search projects, worktrees, and threads"]').setValue('no-such-project');
    await expect($('.palette-empty')).toHaveText(expect.stringContaining('No matches'));
    await browser.keys('Escape');
    await expect($('.command-palette[open]')).not.toExist();
    expect(await browser.execute(() => localStorage.getItem('sai-directory'))).toBe(firstPath);
  });
});
