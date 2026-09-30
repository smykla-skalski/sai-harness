import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const state = mkdtempSync(join(tmpdir(), 'sai-harness-e2e-'));
for (const [name, directory] of Object.entries({
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_CACHE_HOME: 'cache',
  XDG_STATE_HOME: 'state',
})) {
  process.env[name] = join(state, directory);
}

const binary = resolve(
  `src-tauri/target/debug/sai-harness${process.platform === 'win32' ? '.exe' : ''}`,
);

export const config = {
  runner: 'local',
  specs: ['./test/e2e/*.spec.ts'],
  maxInstances: 1,
  services: [['tauri', { appBinaryPath: binary, driverProvider: 'embedded' }]],
  capabilities: [{ browserName: 'tauri', 'tauri:options': { application: binary } }],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'error',
  mochaOpts: { timeout: 90_000 },
  waitforTimeout: 20_000,
  connectionRetryTimeout: 90_000,
  onComplete() {
    rmSync(state, { recursive: true, force: true });
  },
};
