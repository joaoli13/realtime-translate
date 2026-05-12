import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/events';
import type { IpcInvokeMap, IpcSendMap } from './ipc/channels';

const api = {
  hasApiKey: (): Promise<IpcInvokeMap[typeof IPC.GetApiKeyStatus]['result']> =>
    ipcRenderer.invoke(IPC.GetApiKeyStatus),
  getApiKeyHint: (): Promise<IpcInvokeMap[typeof IPC.GetApiKeyHint]['result']> =>
    ipcRenderer.invoke(IPC.GetApiKeyHint),
  setApiKey: (
    value: IpcInvokeMap[typeof IPC.SetApiKey]['args']['value'],
  ): Promise<IpcInvokeMap[typeof IPC.SetApiKey]['result']> =>
    ipcRenderer.invoke(IPC.SetApiKey, { value }),
  clearApiKey: (): Promise<IpcInvokeMap[typeof IPC.ClearApiKey]['result']> =>
    ipcRenderer.invoke(IPC.ClearApiKey),
  listDevices: (): Promise<IpcInvokeMap[typeof IPC.ListDevices]['result']> =>
    ipcRenderer.invoke(IPC.ListDevices),
  startTranslation: (
    args: IpcInvokeMap[typeof IPC.StartTranslation]['args'],
  ): Promise<IpcInvokeMap[typeof IPC.StartTranslation]['result']> =>
    ipcRenderer.invoke(IPC.StartTranslation, args),
  stopTranslation: (): Promise<IpcInvokeMap[typeof IPC.StopTranslation]['result']> =>
    ipcRenderer.invoke(IPC.StopTranslation),

  loadPrefs: (): Promise<IpcInvokeMap[typeof IPC.PrefsLoad]['result']> =>
    ipcRenderer.invoke(IPC.PrefsLoad),
  saveWidgetPosition: (
    pos: IpcInvokeMap[typeof IPC.PrefsSetWidgetPosition]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetWidgetPosition, pos),
  saveLanguages: (
    langs: IpcInvokeMap[typeof IPC.PrefsSetLanguages]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetLanguages, langs),
  saveDevices: (
    devices: IpcInvokeMap[typeof IPC.PrefsSetDevices]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetDevices, devices),
  saveUiLanguage: (
    locale: IpcInvokeMap[typeof IPC.PrefsSetUiLanguage]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetUiLanguage, locale),
  saveMeetConfirmed: (
    value: IpcInvokeMap[typeof IPC.PrefsSetMeetConfirmed]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetMeetConfirmed, value),
  saveRecordingPrefs: (
    value: IpcInvokeMap[typeof IPC.PrefsSetRecording]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetRecording, value),
  saveSilenceGatePrefs: (
    value: IpcInvokeMap[typeof IPC.PrefsSetSilenceGate]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetSilenceGate, value),
  chooseRecordingOutputDir: (): Promise<
    IpcInvokeMap[typeof IPC.RecordingChooseOutputDir]['result']
  > => ipcRenderer.invoke(IPC.RecordingChooseOutputDir),
  openRecordingOutputDir: (
    dir?: IpcInvokeMap[typeof IPC.RecordingOpenOutputDir]['args']['dir'],
  ): Promise<void> => ipcRenderer.invoke(IPC.RecordingOpenOutputDir, { dir }),

  openSetupView: (): Promise<IpcInvokeMap[typeof IPC.OpenSetupView]['result']> =>
    ipcRenderer.invoke(IPC.OpenSetupView),

  markSetupComplete: (): Promise<IpcInvokeMap[typeof IPC.SetupComplete]['result']> =>
    ipcRenderer.invoke(IPC.SetupComplete),

  showBarMenu: (): Promise<IpcInvokeMap[typeof IPC.ShowBarMenu]['result']> =>
    ipcRenderer.invoke(IPC.ShowBarMenu),

  setBarMouseEvents: (
    args: IpcInvokeMap[typeof IPC.SetBarMouseEvents]['args'],
  ): Promise<IpcInvokeMap[typeof IPC.SetBarMouseEvents]['result']> =>
    ipcRenderer.invoke(IPC.SetBarMouseEvents, args),

  quit: (): Promise<IpcInvokeMap[typeof IPC.AppQuit]['result']> =>
    ipcRenderer.invoke(IPC.AppQuit),

  openExternalUrl: (
    url: IpcInvokeMap[typeof IPC.OpenExternalUrl]['args']['url'],
  ): Promise<IpcInvokeMap[typeof IPC.OpenExternalUrl]['result']> =>
    ipcRenderer.invoke(IPC.OpenExternalUrl, { url }),

  resolveLocale: (): Promise<IpcInvokeMap[typeof IPC.ResolveLocale]['result']> =>
    ipcRenderer.invoke(IPC.ResolveLocale),

  // Test Translation (M4 Phase E) — see TestSessionRegistry + loopbackCapture.
  testSessionStart: (
    args: IpcInvokeMap[typeof IPC.TestSessionStart]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestSessionStart, args),
  testSessionInject: (
    args: IpcInvokeMap[typeof IPC.TestSessionInject]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestSessionInject, args),
  testSessionInputDone: (
    args: IpcInvokeMap[typeof IPC.TestSessionInputDone]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestSessionInputDone, args),
  testSessionStop: (
    args: IpcInvokeMap[typeof IPC.TestSessionStop]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestSessionStop, args),
  testLiveStart: (
    args: IpcInvokeMap[typeof IPC.TestLiveStart]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestLiveStart, args),
  testLiveStop: (
    args: IpcInvokeMap[typeof IPC.TestLiveStop]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestLiveStop, args),
  loopbackStart: (
    args: IpcInvokeMap[typeof IPC.LoopbackStart]['args'],
  ): Promise<{ detected: boolean }> => ipcRenderer.invoke(IPC.LoopbackStart, args),
  testRoutePlayback: (
    args: IpcInvokeMap[typeof IPC.TestRoutePlayback]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestRoutePlayback, args),
  /**
   * Subscribe to translated audio chunks emitted by a TestSession. The channel
   * name is dynamic (`test:audio:A` / `test:audio:B`) to keep per-direction
   * subscriptions independent. Bypasses the typed IpcSendMap by design.
   */
  onTestAudio: (
    direction: 'A' | 'B',
    cb: (base64: string) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, b64: string): void => cb(b64);
    ipcRenderer.on(`test:audio:${direction}`, handler);
    return (): void => {
      ipcRenderer.off(`test:audio:${direction}`, handler);
    };
  },
  onTestLivePcm: (
    direction: 'A' | 'B',
    cb: (sample: { kind: 'input' | 'output'; base64: string }) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, sample: { kind: 'input' | 'output'; base64: string }): void =>
      cb(sample);
    ipcRenderer.on(`test:livePcm:${direction}`, handler);
    return (): void => {
      ipcRenderer.off(`test:livePcm:${direction}`, handler);
    };
  },

  onDirectionalState: (
    cb: (s: IpcSendMap[typeof IPC.DirectionalStateChanged]) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, s: IpcSendMap[typeof IPC.DirectionalStateChanged]): void =>
      cb(s);
    ipcRenderer.on(IPC.DirectionalStateChanged, handler);
    return (): void => {
      ipcRenderer.off(IPC.DirectionalStateChanged, handler);
    };
  },
  onTranscript: (cb: (t: IpcSendMap[typeof IPC.TranscriptDelta]) => void): (() => void) => {
    const handler = (_evt: unknown, t: IpcSendMap[typeof IPC.TranscriptDelta]): void => cb(t);
    ipcRenderer.on(IPC.TranscriptDelta, handler);
    return (): void => {
      ipcRenderer.off(IPC.TranscriptDelta, handler);
    };
  },
  onLatency: (cb: (m: IpcSendMap[typeof IPC.LatencyMeasured]) => void): (() => void) => {
    const handler = (_evt: unknown, m: IpcSendMap[typeof IPC.LatencyMeasured]): void => cb(m);
    ipcRenderer.on(IPC.LatencyMeasured, handler);
    return (): void => {
      ipcRenderer.off(IPC.LatencyMeasured, handler);
    };
  },
  onRecordingStatus: (
    cb: (m: IpcSendMap[typeof IPC.RecordingStatusChanged]) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, m: IpcSendMap[typeof IPC.RecordingStatusChanged]): void =>
      cb(m);
    ipcRenderer.on(IPC.RecordingStatusChanged, handler);
    return (): void => {
      ipcRenderer.off(IPC.RecordingStatusChanged, handler);
    };
  },
  onSilenceGateMetrics: (
    cb: (m: IpcSendMap[typeof IPC.SilenceGateMetricsChanged]) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, m: IpcSendMap[typeof IPC.SilenceGateMetricsChanged]): void =>
      cb(m);
    ipcRenderer.on(IPC.SilenceGateMetricsChanged, handler);
    return (): void => {
      ipcRenderer.off(IPC.SilenceGateMetricsChanged, handler);
    };
  },

  // Auto-update bindings (M5 Task 6). Main broadcasts UpdateAvailable +
  // UpdateDownloaded as the wrapper sees those events from electron-updater;
  // FloatingWidget shows a badge in response. Clicking the badge invokes
  // ApplyUpdate, which calls autoUpdater.quitAndInstall().
  applyUpdate: (): Promise<IpcInvokeMap[typeof IPC.ApplyUpdate]['result']> =>
    ipcRenderer.invoke(IPC.ApplyUpdate),
  onUpdateAvailable: (
    cb: (info: IpcSendMap[typeof IPC.UpdateAvailable]) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, info: IpcSendMap[typeof IPC.UpdateAvailable]): void =>
      cb(info);
    ipcRenderer.on(IPC.UpdateAvailable, handler);
    return (): void => {
      ipcRenderer.off(IPC.UpdateAvailable, handler);
    };
  },
  onUpdateDownloaded: (
    cb: (info: IpcSendMap[typeof IPC.UpdateDownloaded]) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, info: IpcSendMap[typeof IPC.UpdateDownloaded]): void =>
      cb(info);
    ipcRenderer.on(IPC.UpdateDownloaded, handler);
    return (): void => {
      ipcRenderer.off(IPC.UpdateDownloaded, handler);
    };
  },
};

declare global {
  interface Window {
    rt: typeof api;
  }
}

contextBridge.exposeInMainWorld('rt', api);

export type RtApi = typeof api;
