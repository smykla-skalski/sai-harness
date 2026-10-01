import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = () =>
  browser.tauri.execute(async ({ core }) => core.invoke<Record<string, string>>('load_settings'));

describe('disk-backed settings', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-settings-'));
  const secondRepository = mkdtempSync(join(tmpdir(), 'sail-settings-second-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['init', '-q', secondRepository]);
  });

  after(async () => {
    await browser.execute(() => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
    });
    rmSync(repository, { recursive: true, force: true });
    rmSync(secondRepository, { recursive: true, force: true });
  });

  it('migrates existing repositories and restores new preferences after reload', async () => {
    const path = realpathSync(repository);
    await browser.execute((selected) => {
      localStorage.clear();
      localStorage.setItem('sai-directory', selected);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [selected], groups: [] }),
      );
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
    }, path);
    await browser.refresh();
    await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();
    expect((await read())['sai-directory']).toBe(path);
    expect(existsSync(join(process.env.SAIL_E2E_CONFIG_DIR!, 'settings.json'))).toBe(true);

    const other = realpathSync(secondRepository);
    await browser.execute((selected) => {
      localStorage.removeItem('sail-settings-migrated-v1');
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({
          repositories: [selected],
          groups: [{ id: 'second', name: 'Second', collapsed: false, repositories: [selected] }],
        }),
      );
    }, other);
    await browser.refresh();
    await expect($(`.project-repository-select[title="${other}"]`)).toBeDisplayed();
    await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();

    await $('button=Dark theme').click();
    await browser.waitUntil(async () => (await read())['sai-theme'] === 'dark');
    await browser.execute(() => localStorage.clear());
    await browser.refresh();
    await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();
    try {
      expect(await browser.execute(() => localStorage.getItem('sai-directory'))).toBe(path);
      expect(await browser.execute(() => localStorage.getItem('sai-theme'))).toBe('dark');
    } catch (cause) {
      console.error('Settings reload diagnostic', {
        disk: await read(),
        browser: await browser.execute(() => ({
          directory: localStorage.getItem('sai-directory'),
          theme: localStorage.getItem('sai-theme'),
          enabled: sessionStorage.getItem('sail-e2e-settings'),
          keys: Object.keys(localStorage),
        })),
      });
      throw cause;
    }
    await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();
    await expect($(`.project-repository-select[title="${other}"]`)).toBeDisplayed();
    await expect($('button=Light theme')).toBeDisplayed();
  });
});
