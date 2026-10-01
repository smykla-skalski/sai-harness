import '@smykla-skalski/sui/styles.css';
import './style.css';
import { mount } from 'svelte';
import { initializeSettings } from './lib/settings';

async function start() {
  if (import.meta.env.MODE === 'e2e') await import('@wdio/tauri-plugin');
  if (new URLSearchParams(location.search).get('window') === 'settings') {
    const { default: SettingsWindow } = await import('./SettingsWindow.svelte');
    mount(SettingsWindow, { target: document.getElementById('root')! });
  } else {
    await initializeSettings();
    const { default: App } = await import('./App.svelte');
    mount(App, { target: document.getElementById('root')! });
  }
}

void start();
