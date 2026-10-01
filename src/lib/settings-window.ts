import type { AgentAvailability } from './acp';
import type { SetupReport } from './onboarding';

export const settingsRequest = 'sail:settings-request';
export const settingsState = 'sail:settings-state';
export const settingsAction = 'sail:settings-action';

export type SettingsSnapshot = {
  theme: 'light' | 'dark';
  binaryPath: string;
  activeBinary: string;
  runtimeState: 'starting' | 'connected' | 'error';
  runtimeError: string;
  directory: string;
  setup: SetupReport | null;
  setupLoading: boolean;
  setupError: string;
  busy: boolean;
  agents: AgentAvailability[];
};

export type SettingsAction =
  | { type: 'theme'; value: 'light' | 'dark' }
  | { type: 'binary'; value: string }
  | { type: 'detect-agents' }
  | { type: 'restart-setup' };
