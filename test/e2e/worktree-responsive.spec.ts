import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('responsive worktree operations', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'sail-responsive-worktree-')));
  const name = repository.split('/').at(-1)!;

  before(async () => {
    execFileSync('git', ['init', '-q', repository]);
    const config = join(repository, '.sail');
    mkdirSync(config);
    writeFileSync(join(config, 'worktree.json'), JSON.stringify({ archive: 'sleep 2' }));
    execFileSync('git', ['-C', repository, 'add', '.sail/worktree.json']);
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
      '-qm',
      'baseline',
    ]);
    const hook = join(repository, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, '#!/bin/sh\nsleep 8\n');
    chmodSync(hook, 0o755);
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({
          repositories: [path],
          groups: [],
          worktrees: {},
        }),
      );
    }, repository);
    await browser.refresh();
    await expect($(`.project-default-worktree-select[title="${repository}"]`)).toBeDisplayed();
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  async function submitWorktree(branch: string, base?: string) {
    await $(`[aria-label="Create worktree for ${name}"]`).click();
    await $(`[aria-label="Worktree name for ${name}"]`).setValue(branch);
    if (base) await $(`[aria-label="Base branch for ${name}"]`).setValue(base);
    await $('.worktree-form button[type="submit"]').click();
  }

  it('closes creation immediately and keeps the current project available', async () => {
    await submitWorktree('slow-create');
    try {
      await expect($('.worktree-dialog')).not.toBeDisplayed();
      await expect($('.project-worktree-pending')).toHaveText(
        expect.stringContaining('slow-create'),
      );
      await expect($(`.project-default-worktree-select[title="${repository}"]`)).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect($('.project-worktree-status')).toHaveText('Creating worktree');
    } catch (cause) {
      console.error('Creation progress diagnostic', {
        sidebar: await $('.sidebar').getText(),
        directory: await browser.execute(() => localStorage.getItem('sai-directory')),
        catalog: await browser.execute(() => localStorage.getItem('sai-project-catalog')),
        registered: execFileSync('git', ['-C', repository, 'worktree', 'list'], {
          encoding: 'utf8',
        }),
      });
      throw cause;
    }
    await expect($('.project-worktree-pending')).not.toExist();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory')))?.endsWith(
          '/slow-create',
        ) ?? false,
    );
  });

  it('shows creation failure and lets the user retry', async () => {
    await $(`.project-default-worktree-select[title="${repository}"]`).click();
    await submitWorktree('retry-create', 'retry-base');
    await expect($('.project-worktree-pending')).toHaveText(
      expect.stringContaining('retry-create'),
    );
    await expect($('[aria-label="Retry creating worktree retry-create"]')).toBeDisplayed();
    expect(await browser.execute(() => localStorage.getItem('sai-project-catalog'))).not.toContain(
      'retry-create',
    );
    execFileSync('git', ['-C', repository, 'branch', 'retry-base']);
    await $('[aria-label="Retry creating worktree retry-create"]').click();
    await expect($('[aria-label="Retry creating worktree retry-create"]')).not.toExist();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory')))?.endsWith(
          '/retry-create',
        ) ?? false,
    );
  });

  it('shows archive and deletion progress, then removes the row', async () => {
    const path = await browser.execute(() => localStorage.getItem('sai-directory'));
    if (!path) throw new Error('No selected worktree');
    await $(`.project-worktree-select[title="${path}"]`).click({ button: 'right' });
    await browser.execute(() => sessionStorage.setItem('sai-e2e-delete-worktree', 'Yes'));
    await $('[aria-label="Delete worktree retry-create"]').click();
    await expect($(`.project-worktree-select[title="${path}"]`)).toBeDisabled();
    await expect($('.project-worktree-status')).toHaveText('Archiving');
    await expect($(`.project-worktree-select[title="${path}"]`)).not.toExist();
    expect(existsSync(path)).toBe(false);
  });
});
