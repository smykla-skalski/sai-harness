import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const input = () => $('[aria-label="Search command palette"]');

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await browser.saveScreenshot(join(output, `${name}.png`));
}

async function openPalette() {
  await browser.keys(['Meta', 'k']);
  await expect($('.command-palette[open]')).toBeDisplayed();
  await expect(input()).toBeFocused();
}

async function searchAndEnter(query: string) {
  await input().setValue(query);
  await browser.keys('Enter');
}

describe('command palette project flow', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-palette-repo-'));
  const worktreeParent = mkdtempSync(join(tmpdir(), 'sail-palette-worktree-'));
  const worktree = join(worktreeParent, 'feature');

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'test(fixture): create repository',
    ]);
    execFileSync('git', [
      '-C',
      repository,
      'worktree',
      'add',
      '-q',
      '-b',
      'palette-feature',
      worktree,
    ]);
  });

  after(() => {
    rmSync(worktreeParent, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  });

  it('drills from project to worktree, agent, and existing or new session', async () => {
    const repoPath = realpathSync(repository);
    const worktreePath = realpathSync(worktree);
    await browser.execute(
      (repo, branch) => {
        sessionStorage.removeItem('sail-e2e-settings');
        localStorage.removeItem('sai-pane-layouts');
        localStorage.setItem('sai-directory', repo);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [{ id: 'team', name: 'Team', collapsed: false, repositories: [repo] }],
            worktrees: { [repo]: [{ path: branch, branch: 'palette-feature' }] },
          }),
        );
        localStorage.setItem(
          'sail-agent-threads',
          JSON.stringify([
            {
              agent: 'claude',
              directory: branch,
              sessionId: 'old',
              title: 'Old thread',
              updated: Date.now() - 1000,
            },
            {
              agent: 'claude',
              directory: branch,
              sessionId: 'new',
              title: 'Newest thread',
              updated: Date.now(),
            },
          ]),
        );
      },
      repoPath,
      worktreePath,
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeDisplayed();

    await openPalette();
    await capture('palette-projects');
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await expect($('.palette-path')).toHaveText(
      expect.stringContaining(repoPath.split('/').at(-1)!),
    );
    await expect($('[data-kind="new-worktree"]')).toBeDisplayed();
    await capture('palette-worktrees');
    await searchAndEnter('palette-feature');
    await expect($('[data-kind="agent"]')).toBeDisplayed();
    await capture('palette-agents');
    await searchAndEnter('Claude');
    await expect($('[data-kind="new-session"]')).toBeDisplayed();
    await expect($('.palette-results')).toHaveText(expect.stringContaining('Newest thread'));
    await capture('palette-sessions');
    await searchAndEnter('Newest thread');
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === worktreePath,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Newest thread'));

    await openPalette();
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await $('[data-kind="worktree"]').click();
    await searchAndEnter('Claude');
    await $('[data-kind="new-session"]').click();
    await browser.waitUntil(
      async () => (await browser.execute(() => localStorage.getItem('sai-directory'))) === repoPath,
    );
    await expect($('textarea[aria-label="Message Claude"]')).toBeFocused();

    await openPalette();
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await searchAndEnter('palette-feature');
    await searchAndEnter('Claude');
    await $('[data-kind="new-session"]').click();
    await expect($('textarea[aria-label="Message Claude"]')).toBeFocused();

    await openPalette();
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await searchAndEnter('palette-feature');
    await browser.keys('Backspace');
    await expect($('[data-kind="new-worktree"]')).toBeDisplayed();
    await browser.keys('Escape');
    await expect($('.command-palette[open]')).not.toExist();
  });

  it('uses the worktree popup and returns to agent selection after creation', async () => {
    const repoPath = realpathSync(repository);
    await openPalette();
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await $('[data-kind="new-worktree"]').click();
    await expect($('.worktree-dialog[open]')).toBeDisplayed();
    await capture('palette-create-worktree');
    await expect($('.worktree-dialog')).toHaveText(
      expect.stringContaining('Choose an agent and session after creation.'),
    );
    await $('.worktree-cancel').click();
    await expect($('.command-palette[open]')).toBeDisplayed();
    await expect($('[data-kind="new-worktree"]')).toBeDisplayed();
    await $('[data-kind="new-worktree"]').click();
    await expect($('.worktree-dialog[open]')).toBeDisplayed();
    await $('[aria-label^="Worktree name for"]').setValue('palette-created');
    await $('.worktree-create').click();
    await expect($('.worktree-dialog[open]')).not.toExist();
    await expect($('.command-palette[open]')).toBeDisplayed();
    await expect($('.palette-path')).toHaveText(expect.stringContaining('palette-created'));
    await expect($('[data-kind="agent"]')).toBeDisplayed();
    await searchAndEnter('Claude');
    await $('[data-kind="new-session"]').click();
    await expect($('textarea[aria-label="Message Claude"]')).toBeFocused();
    const selected = await browser.execute(() => localStorage.getItem('sai-directory'));
    expect(selected).toContain('palette-created');
  });
});
