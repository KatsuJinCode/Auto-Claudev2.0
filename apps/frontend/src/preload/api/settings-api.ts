import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  AppSettings,
  IPCResult,
  SourceEnvConfig,
  SourceEnvCheckResult
} from '../../shared/types';

// Dev mode event listener type
export interface DevBackendChangedInfo {
  file: string;
  timestamp: number;
}

export interface SettingsAPI {
  // App Settings
  getSettings: () => Promise<IPCResult<AppSettings>>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<IPCResult>;

  // App Info
  getAppVersion: () => Promise<string>;
  restartApp: () => Promise<void>;

  // Auto-Build Source Environment
  getSourceEnv: () => Promise<IPCResult<SourceEnvConfig>>;
  updateSourceEnv: (config: { claudeOAuthToken?: string }) => Promise<IPCResult>;
  checkSourceToken: () => Promise<IPCResult<SourceEnvCheckResult>>;

  // Dev mode notifications
  onDevBackendChanged: (callback: (info: DevBackendChangedInfo) => void) => () => void;
}

export const createSettingsAPI = (): SettingsAPI => ({
  // App Settings
  getSettings: (): Promise<IPCResult<AppSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),

  saveSettings: (settings: Partial<AppSettings>): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings),

  // App Info
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),

  restartApp: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_RESTART),

  // Auto-Build Source Environment
  getSourceEnv: (): Promise<IPCResult<SourceEnvConfig>> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_GET),

  updateSourceEnv: (config: { claudeOAuthToken?: string }): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_UPDATE, config),

  checkSourceToken: (): Promise<IPCResult<SourceEnvCheckResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_CHECK_TOKEN),

  // Dev mode notifications
  onDevBackendChanged: (callback: (info: DevBackendChangedInfo) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      info: DevBackendChangedInfo
    ): void => {
      callback(info);
    };
    ipcRenderer.on(IPC_CHANNELS.DEV_BACKEND_CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DEV_BACKEND_CHANGED, handler);
    };
  }
});
