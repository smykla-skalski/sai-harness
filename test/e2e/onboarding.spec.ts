import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('repository setup', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sai-onboarding-'));
  const secondRepository = mkdtempSync(join(tmpdir(), 'sai-onboarding-second-'));

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
    execFileSync('git', ['init', '-q', secondRepository]);
  });

  after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(secondRepository, { recursive: true, force: true });
  });

  it('lists named project groups and switches repositories', async () => {
    await browser.execute(
      (first, second) => {
        localStorage.setItem('sai-directory', first);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [first, second],
            groups: [{ id: 'work', name: 'Work', collapsed: false, repositories: [second] }],
          }),
        );
      },
      repository,
      secondRepository,
    );
    await browser.refresh();
    await expect($('.project-group-toggle')).toHaveText(expect.stringContaining('Work'));
    await expect($(`.project-repository-select[title="${secondRepository}"]`)).toBeEnabled();
    await $(`.project-repository-select[title="${secondRepository}"]`).click();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) ===
        realpathSync(secondRepository),
      { timeout: 60_000, timeoutMsg: 'App did not switch to the selected repository' },
    );
    expect(await browser.execute(() => localStorage.getItem('sai-directory'))).toBe(
      realpathSync(secondRepository),
    );
    await expect(
      $(`.project-repository-select[title="${realpathSync(secondRepository)}"]`),
    ).toHaveAttribute('aria-current', 'page');
    await $('.project-group-toggle').click();
    await expect($('.project-group-toggle')).toHaveAttribute('aria-expanded', 'false');
    await $('[aria-label="Add project group"]').click();
    await $('[aria-label="New project group name"]').setValue('Personal');
    await $('[aria-label="Save project group"]').click();
    await expect($('[title="Personal"].project-group-toggle')).toBeDisplayed();
    await browser.refresh();
    await expect($('.project-group-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect($('[title="Personal"].project-group-toggle')).toBeDisplayed();
  });

  it('rejects a directory that is not a Git repository', async () => {
    const result = await browser.tauri.execute(async ({ core }, path) => {
      try {
        await core.invoke('validate_repository', { path });
        return 'accepted';
      } catch (cause) {
        return String(cause);
      }
    }, tmpdir());
    expect(result).toContain('not inside a Git repository');
  });

  it('shows setup guidance for a fresh repository without the plugin', async () => {
    await $(`.project-repository-select[title="${realpathSync(repository)}"]`).click();
    try {
      await browser.waitUntil(
        async () => (await $('.setup-panel').getText()).includes(realpathSync(repository)),
        { timeout: 20_000, timeoutMsg: 'App did not inspect the selected repository' },
      );
    } catch (cause) {
      console.error('Repository setup diagnostic', {
        savedDirectory: await browser.execute(() => localStorage.getItem('sai-directory')),
        setup: await $('.setup-panel').getText(),
        sidebar: await $('.sidebar').getText(),
      });
      throw cause;
    }
    await expect($('.setup-panel')).toHaveText(expect.stringContaining(realpathSync(repository)));
    await expect($('.setup-panel')).toHaveText(
      expect.stringContaining('Plan-review plugin not loaded'),
    );
    await expect($('.setup-panel')).toHaveText(
      expect.stringContaining(
        'github:smykla-skalski/opencode-plugin-plan-review#fdc575ba5ffccc6420ad5b3b68372f99f70290f5',
      ),
    );
    await expect($('[aria-label="New plan"]')).toBeDisabled();
    if ((await $('.topbar-actions').getText()).includes('Setup needed'))
      await expect($('.composer textarea')).toBeDisabled();
    else await expect($('.composer textarea')).toBeEnabled();
  });

  it('creates and opens a worktree in the Sail workspace', async () => {
    const name = 'sidebar-task';
    const repositoryName = realpathSync(repository).split('/').at(-1);
    await $(`[aria-label="Create worktree for ${repositoryName}"]`).click();
    await $(`[aria-label="Worktree name for ${repositoryName}"]`).setValue(name);
    await $('.worktree-form button[type="submit"]').click();
    try {
      await browser.waitUntil(
        async () =>
          (await browser.execute(() => localStorage.getItem('sai-directory')))?.endsWith(
            `/${name}`,
          ) ?? false,
        { timeout: 15_000, timeoutMsg: 'New worktree did not open' },
      );
    } catch (cause) {
      console.error('Worktree creation diagnostic', {
        form: await $('.worktree-form').getText(),
        sidebar: await $('.sidebar').getText(),
        gitWorktrees: execFileSync('git', ['-C', repository, 'worktree', 'list'], {
          encoding: 'utf8',
        }),
      });
      throw cause;
    }
    const worktree = await browser.execute(() => localStorage.getItem('sai-directory'));
    expect(worktree).toContain(realpathSync(process.env.SAIL_WORKTREE_ROOT!));
    expect(
      execFileSync('git', ['-C', worktree!, 'branch', '--show-current'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(name);
    await browser.refresh();
    await expect($(`.project-worktree-select[title="${worktree}"]`)).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect($('.setup-panel')).toHaveText(
      expect.stringContaining('Plan-review plugin not loaded'),
    );
  });

  it('creates a worktree from an explicitly selected base branch', async () => {
    execFileSync('git', ['-C', repository, 'branch', 'develop']);
    const baseCommit = execFileSync('git', ['-C', repository, 'rev-parse', 'develop'], {
      encoding: 'utf8',
    }).trim();
    const created = await browser.tauri.execute(async ({ core }, path) => {
      return core.invoke<{ path: string; base: string }>('create_worktree', {
        repository: path,
        name: 'from-develop',
        destinationParent: null,
        baseRef: 'develop',
      });
    }, repository);
    expect(created.base).toBe('develop');
    expect(
      execFileSync('git', ['-C', created.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ).toBe(baseCommit);
  });

  it('shows an actionable error for a saved invalid path', async () => {
    await browser.execute(
      (path) => localStorage.setItem('sai-directory', path),
      join(repository, 'gone'),
    );
    await browser.refresh();
    await expect($('.setup-panel [role="alert"]')).toHaveText(
      'Repository path does not exist. Choose an existing directory.',
    );
    await expect($('.composer textarea')).toBeDisabled();
  });
});
