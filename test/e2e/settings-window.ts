import { browser, $ } from '@wdio/globals';

export async function openSettings() {
  await $('[aria-label="Settings"]').click();
  try {
    await browser.waitUntil(async () => (await browser.tauri.listWindows()).includes('settings'), {
      timeout: 5000,
    });
  } catch {
    await $('[aria-label="Settings"]').click();
    await browser.waitUntil(async () => (await browser.tauri.listWindows()).includes('settings'));
  }
  await browser.tauri.switchWindow('settings');
  await $('.settings-window').waitForDisplayed();
}

export async function returnToWorkspace() {
  await browser.tauri.switchWindow('main');
  await browser.tauri.execute(async ({ core }) => {
    await core.invoke('plugin:window|close', { label: 'settings' });
  });
  await browser.waitUntil(async () => !(await browser.tauri.listWindows()).includes('settings'));
}
