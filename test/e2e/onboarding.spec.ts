import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('repository setup', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sai-onboarding-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
  });

  after(() => {
    rmSync(repository, { recursive: true, force: true });
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
    await browser.execute((path) => localStorage.setItem('sai-directory', path), repository);
    await browser.refresh();
    await browser.waitUntil(async () => (await $('.setup-panel').getText()).includes(repository), {
      timeout: 60_000,
      timeoutMsg: 'App did not inspect the selected repository',
    });
    await expect($('.setup-panel')).toHaveText(expect.stringContaining(repository));
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
