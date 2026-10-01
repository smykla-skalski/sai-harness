import { browser, $, expect } from '@wdio/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { returnToWorkspace, openSettings } from './settings-window';

declare global {
  interface Window {
    runtimeStates?: string[];
  }
}

async function runtimeInfo() {
  return browser.tauri.execute(async ({ core }) => {
    const info = await core.invoke<{ url: string; password: string; binaryPath: string }>(
      'start_runtime',
      { binaryPath: null, restart: false },
    );
    return { url: info.url, binaryPath: info.binaryPath };
  });
}

async function serverPid() {
  return browser.tauri.execute(async ({ core }) => {
    const info = await core.invoke<{ url: string; password: string }>('start_runtime', {
      binaryPath: null,
      restart: false,
    });
    const authorization = `Basic ${btoa(`opencode:${info.password}`)}`;
    const response = await fetch(`${info.url}/api/info`, { headers: { authorization } });
    const server: unknown = await response.json();
    if (
      typeof server !== 'object' ||
      server === null ||
      !('pid' in server) ||
      typeof server.pid !== 'number'
    ) {
      throw new Error('OpenCode did not return a process ID');
    }
    return server.pid;
  });
}

describe('OpenCode runtime', () => {
  it('detects OpenCode and preserves a live server after an invalid setting', async () => {
    await expect($('.sidebar-footer')).toHaveText('OpenCode connected');
    const initial = await runtimeInfo();
    expect(initial.binaryPath).toContain('opencode');

    await openSettings();
    await $('.settings-navigation button:nth-child(2)').click();
    await expect($('.runtime-binary[title]')).toHaveText(expect.stringContaining('Detected:'));
    await $('#opencode-bin').setValue(join(tmpdir(), 'no-such-opencode-for-sai'));
    await $('button=Save and reconnect').click();
    await expect($('.runtime-diagnostic')).toBeDisplayed();
    await expect($('.runtime-diagnostic')).toHaveText(
      expect.stringContaining('The current OpenCode connection remains active.'),
    );
    await browser.tauri.switchWindow('main');
    await expect($('.sidebar-footer')).toHaveText(expect.stringContaining('OpenCode connected'));
    expect((await runtimeInfo()).url).toBe(initial.url);

    await browser.tauri.switchWindow('settings');
    await $('#opencode-bin').setValue('');
    await $('button=Save and reconnect').click();
    await browser.tauri.switchWindow('main');
    await expect($('.sidebar-footer')).toHaveText(expect.stringContaining('OpenCode connected'));
    expect((await runtimeInfo()).url).not.toBe(initial.url);
    await browser.tauri.switchWindow('settings');
    await returnToWorkspace();
  });

  it('recovers after its OpenCode child exits', async () => {
    await expect($('.sidebar-footer')).toHaveText('OpenCode connected');
    await browser.execute(() => {
      const footer = document.querySelector('.sidebar-footer');
      const states: string[] = [];
      new MutationObserver(() => states.push(footer?.textContent?.trim() ?? '')).observe(footer!, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      window.runtimeStates = states;
    });
    const oldPid = await serverPid();
    process.kill(oldPid, 'SIGKILL');
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const states = window.runtimeStates ?? [];
          return (
            states.some((state) => state.includes('starting')) &&
            document.querySelector('.sidebar-footer')?.textContent?.includes('connected')
          );
        }),
      { timeout: 20_000, timeoutMsg: 'App did not reconnect after OpenCode exited' },
    );
    expect(await serverPid()).not.toBe(oldPid);
  });
});
