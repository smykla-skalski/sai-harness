import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('recent thread shortcuts', () => {
  const first = mkdtempSync(join(tmpdir(), 'sail-recent-first-'));
  const second = mkdtempSync(join(tmpdir(), 'sail-recent-second-'));

  before(() => {
    execFileSync('git', ['init', '-q', first]);
    execFileSync('git', ['init', '-q', second]);
  });
  after(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });

  it('jumps across projects, ignores empty slots, and persists visit order', async () => {
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
        const threads = [
          { agent: 'claude', directory: a, sessionId: 'one', title: 'Thread one', updated: 3 },
          { agent: 'claude', directory: b, sessionId: 'two', title: 'Thread two', updated: 2 },
          { agent: 'claude', directory: b, sessionId: 'three', title: 'Thread three', updated: 1 },
        ];
        localStorage.setItem('sail-agent-threads', JSON.stringify(threads));
        localStorage.setItem(
          'sai-recent-agent-threads',
          JSON.stringify(
            threads.map((thread) =>
              JSON.stringify([thread.agent, thread.directory, thread.sessionId]),
            ),
          ),
        );
      },
      firstPath,
      secondPath,
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeDisplayed();

    await browser.keys(['Meta', '2']);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === secondPath,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Thread two'));

    await browser.keys(['Meta', '9']);
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Thread two'));
    await expect($('.notice.error')).not.toExist();

    await browser.refresh();
    await expect($('.agent-launches button')).toBeDisplayed();
    await browser.keys(['Meta', '1']);
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Thread two'));

    await browser.keys(['Control', 'Tab']);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === firstPath,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Thread one'));
  });
});
