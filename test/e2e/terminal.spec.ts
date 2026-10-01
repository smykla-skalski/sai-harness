import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('shell terminal panes', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-terminal-repo-'));
  const other = mkdtempSync(join(tmpdir(), 'sail-terminal-other-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['init', '-q', other]);
  });
  after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it('starts in the project, retains scrollback across project switches, and restarts after exit', async () => {
    const paths = [realpathSync(repository), realpathSync(other)];
    await browser.execute(([first, second]) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.setItem('sai-directory', first);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [first, second], groups: [], worktrees: {} }),
      );
    }, paths);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    await browser.keys(['Meta', 't']);
    await expect($('.terminal-screen .xterm')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
    );
    await browser.keys(`printf 'terminal-ready:%s\\n' "$PWD"\n`);
    await browser.waitUntil(() =>
      browser.execute(
        (path) =>
          document
            .querySelector('.terminal-screen .xterm-accessibility-tree')
            ?.textContent?.includes(`terminal-ready:${path}`) ?? false,
        paths[0],
      ),
    );
    await $(`.project-repository-select[title="${paths[1]}"]`).click();
    await $(`.project-repository-select[title="${paths[0]}"]`).click();
    await expect($('.terminal-screen .xterm')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(
        (path) =>
          document
            .querySelector('.terminal-screen .xterm-accessibility-tree')
            ?.textContent?.includes(`terminal-ready:${path}`) ?? false,
        paths[0],
      ),
    );
    await browser.keys('exit 7\n');
    await expect($('.terminal-exit')).toHaveText(expect.stringContaining('code 7'));
    await $('.terminal-exit button').click();
    await expect($('.terminal-exit')).not.toExist();
    await browser.keys('echo restarted\n');
    await browser.waitUntil(() =>
      browser.execute(() =>
        document
          .querySelector('.terminal-screen .xterm-accessibility-tree')
          ?.textContent?.includes('restarted'),
      ),
    );
    await browser.keys(['Meta', 'w']);
    await expect($('.terminal-screen')).not.toExist();
  });
});
