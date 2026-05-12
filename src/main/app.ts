import * as electron from 'electron';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { registerIpcHandlers } from './ipc/handlers';
import { validateExternalUrl } from './ipc/openExternalUrl';
import { setupAutoUpdate } from './updater';
import { type WebSocketLike, type WebSocketFactory } from './translate/openaiSession';
import { type OffscreenController } from './translate/audioPipeline';
import { SessionManager } from './translate/sessionManager';
import { TestSessionRegistry } from './translate/testSession';
import { LocalSilenceGate } from './translate/silenceGate';
import { runLoopback } from './audio/loopbackCapture';
import { detectVirtualCables, type CablePair, type DeviceInfo } from './audio/deviceDetector';
import { createLogger, LogLevel } from './util/logger';
import { JsonlSink } from './util/jsonlSink';
import { ConfigStore } from './config/configStore';
import { UserPrefsStore } from './config/userPrefsStore';
import { readEnvApiKey } from './config/envFallback';
import { RecordingManager, type RecordingSession } from './recording/recordingManager';
import { resolveLocale } from './i18n/resolveLocale';
import { createT, getDictionary } from '../shared/i18n';
import type { LanguageCode } from '../shared/languages';
import { IPC } from '../shared/events';
import type {
  DeviceInventory,
  DeviceSummary,
  Direction,
  DirectionalState,
  RecordingStatus,
  SilenceGateMetrics,
} from '../shared/types';
import { normalizeRecordingPrefs, recordingHasAnyArtifact } from '../shared/types';

const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, screen, session, shell } = electron;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEV_BASE = process.env.ELECTRON_RENDERER_URL;
const FLOATING_WIDGET_URL = DEV_BASE
  ? `${DEV_BASE.replace(/\/$/, '')}/floating-widget.html`
  : `file://${resolve(__dirname, '../renderer/floating-widget.html')}`;
const SETUP_VIEW_URL = DEV_BASE
  ? `${DEV_BASE.replace(/\/$/, '')}/setup-view.html`
  : `file://${resolve(__dirname, '../renderer/setup-view.html')}`;
const OFFSCREEN_URL = DEV_BASE
  ? `${DEV_BASE.replace(/\/$/, '')}/offscreen.html`
  : `file://${resolve(__dirname, '../renderer/offscreen.html')}`;

let floatingWidget: BrowserWindowType | null = null;
let setupView: BrowserWindowType | null = null;
let offscreenWindow: BrowserWindowType | null = null;
let logSink: JsonlSink | undefined;

const wsFactory: WebSocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers });
  const handle: WebSocketLike & {
    onopen?: () => void;
    onclose?: (c: number, r: string) => void;
    onmessage?: (d: string) => void;
    onerror?: (e: Error) => void;
  } = {
    get readyState() {
      return ws.readyState;
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  };
  ws.on('open', () => handle.onopen?.());
  ws.on('close', (c, r) => handle.onclose?.(c, r.toString()));
  ws.on('message', (d) => handle.onmessage?.(d.toString()));
  ws.on('error', (e) => handle.onerror?.(e));
  return handle;
};

class OffscreenBridge implements OffscreenController {
  private pcmCallbacks = new Map<string, (b64: string) => void>();

  constructor(private readonly window: BrowserWindowType) {
    ipcMain.on('offscreen:pcm', (_e, payload: { streamId: string; base64: string }) => {
      this.pcmCallbacks.get(payload.streamId)?.(payload.base64);
    });
  }

  private isAlive(): boolean {
    return !this.window.isDestroyed() && !this.window.webContents.isDestroyed();
  }

  async startCapture(
    streamId: string,
    deviceId: string,
    onPcm: (b64: string) => void,
  ): Promise<void> {
    this.pcmCallbacks.set(streamId, onPcm);
    if (!this.isAlive()) return;
    await this.window.webContents.executeJavaScript(
      `window.offscreen.startCapture(${JSON.stringify(streamId)}, ${JSON.stringify(deviceId)})`,
    );
  }
  async startPlayback(streamId: string, deviceId: string): Promise<void> {
    if (!this.isAlive()) return;
    await this.window.webContents.executeJavaScript(
      `window.offscreen.startPlayback(${JSON.stringify(streamId)}, ${JSON.stringify(deviceId)})`,
    );
  }
  pushPlayback(streamId: string, b64: string): void {
    if (!this.isAlive()) return;
    this.window.webContents.send('offscreen:pushPlayback', { streamId, base64: b64 });
  }
  stopStream(streamId: string): void {
    this.pcmCallbacks.delete(streamId);
    if (!this.isAlive()) return;
    this.window.webContents
      .executeJavaScript(`window.offscreen.stopStream(${JSON.stringify(streamId)})`)
      .catch(() => undefined);
  }
  stopAll(): void {
    this.pcmCallbacks.clear();
    if (!this.isAlive()) return;
    this.window.webContents
      .executeJavaScript('window.offscreen.stopAll()')
      .catch(() => undefined);
  }
}

/**
 * setWindowOpenHandler closure used on every BrowserWindow that loads renderer
 * HTML. Defense-in-depth: any window.open / target=_blank attempt is denied
 * and redirected through validateExternalUrl + shell.openExternal so it lands
 * in the user's default browser instead of an in-app BrowserWindow with no
 * chrome. Most call sites already use the typed IPC; this catches legacy HTML
 * or future contributors who miss it. Exempt: offscreenWindow (no user content).
 */
function attachExternalLinkHandler(window: BrowserWindowType): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = validateExternalUrl(url);
      void shell.openExternal(parsed.toString());
    } catch (err) {
      // Log so a malformed URL or unexpected protocol surfaces in dev — most
      // common cause is a renderer bug that didn't go through the typed IPC.
      // eslint-disable-next-line no-console
      console.warn('[external-link] blocked window-open', { url, error: (err as Error).message });
    }
    return { action: 'deny' };
  });
}

function toDeviceSummary(d: DeviceInfo): DeviceSummary {
  return { deviceId: d.deviceId, label: d.label, kind: d.kind };
}

function toInventoryPair(pair: CablePair): NonNullable<DeviceInventory['cableA']> {
  return {
    ...(pair.label ? { label: pair.label } : {}),
    ...(pair.provider ? { provider: pair.provider } : {}),
    ...(pair.playback ? { playback: toDeviceSummary(pair.playback) } : {}),
    ...(pair.recording ? { recording: toDeviceSummary(pair.recording) } : {}),
  };
}

async function buildDeviceInventory(window: BrowserWindowType): Promise<DeviceInventory> {
  const raw: { deviceId: string; label: string; kind: string }[] =
    await window.webContents.executeJavaScript('window.offscreen.listDevices()');
  const typed: DeviceInfo[] = raw.map((d) => ({
    deviceId: d.deviceId,
    label: d.label,
    kind: d.kind as 'audioinput' | 'audiooutput',
  }));
  const detection = detectVirtualCables(typed, process.platform);
  const inventory: DeviceInventory = {
    platform: detection.platform,
    inputs: detection.realDevices.inputs.map(toDeviceSummary),
    outputs: detection.realDevices.outputs.map(toDeviceSummary),
    virtualInputs: detection.virtualDevices.inputs.map(toDeviceSummary),
    virtualOutputs: detection.virtualDevices.outputs.map(toDeviceSummary),
  };
  if (detection.cableA) {
    inventory.cableA = toInventoryPair(detection.cableA);
  }
  if (detection.cableB) {
    inventory.cableB = toInventoryPair(detection.cableB);
  }
  return inventory;
}

function computeWidgetPosition(
  preferred: { x: number; y: number } | undefined,
  windowWidth: number,
  windowHeight: number,
): { x: number; y: number } {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  // If preferred is on-screen, use it.
  if (preferred) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const w = d.workArea;
      return preferred.x >= w.x && preferred.y >= w.y &&
        preferred.x + windowWidth <= w.x + w.width &&
        preferred.y + windowHeight <= w.y + w.height;
    });
    if (onScreen) return preferred;
  }
  // Default: centered horizontally, 4px above the taskbar (workArea bottom).
  return {
    x: wa.x + Math.round((wa.width - windowWidth) / 2),
    y: wa.y + wa.height - windowHeight - 4,
  };
}

function isSetupComplete(configStore: ConfigStore, prefsStore: UserPrefsStore): boolean {
  // Setup is complete iff API key is stored AND all 4 devices are remembered.
  const hasKey = configStore.getApiKey() !== undefined;
  if (!hasKey) return false;
  const prefs = prefsStore.load();
  const d = prefs.devices;
  return Boolean(d?.mic && d?.toMeet && d?.fromMeet && d?.headset);
}

async function createFloatingWidget(prefsStore: UserPrefsStore): Promise<BrowserWindowType> {
  if (floatingWidget && !floatingWidget.isDestroyed()) {
    floatingWidget.focus();
    return floatingWidget;
  }
  const win = new BrowserWindow({
    width: 480,
    height: 40,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  attachExternalLinkHandler(win);

  const stored = prefsStore.load().widgetPosition;
  const initial = computeWidgetPosition(stored, 480, 40);
  win.setPosition(initial.x, initial.y);

  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  win.on('moved', () => {
    const pos = win.getPosition();
    const x = pos[0];
    const y = pos[1];
    if (x === undefined || y === undefined) return;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => prefsStore.setWidgetPosition({ x, y }), 300);
  });
  win.on('closed', () => {
    if (moveTimer) clearTimeout(moveTimer);
    floatingWidget = null;
  });

  // Assign before awaiting loadURL so a concurrent call (e.g. double-click on
  // "Concluir setup") sees the in-flight window and short-circuits via the
  // guard above instead of constructing a second BrowserWindow. Mirrors the
  // synchronous-assignment pattern in createSetupView.
  floatingWidget = win;
  await win.loadURL(FLOATING_WIDGET_URL);
  return win;
}

async function createWindows(configStore: ConfigStore, prefsStore: UserPrefsStore): Promise<void> {
  offscreenWindow = new BrowserWindow({
    width: 1, height: 1, show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/offscreenPreload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  await offscreenWindow.loadURL(OFFSCREEN_URL);

  if (isSetupComplete(configStore, prefsStore)) {
    await createFloatingWidget(prefsStore);
    if (DEV_BASE) {
      await createSetupView('#/review');
    }
  } else {
    await createSetupView();
  }
}

async function createSetupView(initialHash = ''): Promise<BrowserWindowType> {
  if (setupView && !setupView.isDestroyed()) {
    setupView.focus();
    return setupView;
  }
  setupView = new BrowserWindow({
    width: 720,
    height: 640,
    backgroundColor: '#08090a',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupView.on('closed', () => {
    setupView = null;
  });
  attachExternalLinkHandler(setupView);
  await setupView.loadURL(`${SETUP_VIEW_URL}${initialHash}`);
  return setupView;
}

app.whenReady().then(async () => {
  // Auto-grant `media` permission so the offscreen window can call
  // navigator.mediaDevices.getUserMedia and enumerateDevices without a prompt.
  // BYOK desktop app — the user already trusts this binary to access the mic.
  // Other permissions (camera, notifications, etc.) are denied by default.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  // Stores must be constructed AFTER app is ready (uses app.getPath).
  // Lifted from handlers.ts so createWindows() can use prefsStore for initial
  // position BEFORE the IPC layer is set up.
  const apiKeyPath = join(app.getPath('userData'), 'apikey.bin');
  const configStore = new ConfigStore({
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (s) => safeStorage.encryptString(s),
      decryptString: (b) => safeStorage.decryptString(b),
    },
    fs: {
      readFile: (p) => (existsSync(p) ? readFileSync(p) : undefined),
      writeFile: (p, d) => writeFileSync(p, d),
      exists: (p) => existsSync(p),
    },
    configPath: apiKeyPath,
    envApiKey: readEnvApiKey(),
  });

  const prefsPath = join(app.getPath('userData'), 'prefs.json');
  const prefsStore = new UserPrefsStore({
    fs: {
      readFile: (p) => (existsSync(p) ? readFileSync(p) : undefined),
      writeFile: (p, d) => writeFileSync(p, d),
      exists: (p) => existsSync(p),
    },
    prefsPath,
  });

  await createWindows(configStore, prefsStore);
  if (!offscreenWindow) throw new Error('offscreen window not created');

  const logsDir = join(app.getPath('userData'), 'logs');
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  logSink = new JsonlSink({ logsDir, sessionId });
  const logger = createLogger({ source: 'main', sink: logSink, minLevel: LogLevel.Info });

  const offscreenBridge = new OffscreenBridge(offscreenWindow);

  // Both the FloatingWidget and SetupView (when open) want session state +
  // latency so their UIs reflect what's happening. The TestRig stub leans on
  // this during first-launch (before the bar exists), and the gear-opened
  // SetupView would otherwise show stale "idle" mid-session. Fan out to all
  // alive UI windows; offscreen never subscribes.
  const broadcast = <T,>(channel: string, payload: T): void => {
    for (const win of [floatingWidget, setupView]) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  };
  const emitDirectionalState = (s: DirectionalState): void => {
    broadcast(IPC.DirectionalStateChanged, s);
  };
  const emitTranscript = (t: {
    direction: 'A' | 'B';
    kind: 'input' | 'output';
    text: string;
  }): void => {
    broadcast(IPC.TranscriptDelta, t);
  };
  const emitLatency = (m: { direction: Direction; averageMs: number; sampleCount: number }): void => {
    broadcast(IPC.LatencyMeasured, m);
  };
  const emitRecordingStatus = (status: RecordingStatus): void => {
    broadcast(IPC.RecordingStatusChanged, status);
  };
  const emitSilenceGateMetrics = (metrics: SilenceGateMetrics): void => {
    broadcast(IPC.SilenceGateMetricsChanged, metrics);
  };
  const defaultRecordingsDir = join(app.getPath('userData'), 'recordings');
  mkdirSync(defaultRecordingsDir, { recursive: true });
  const recordingManager = new RecordingManager({
    defaultOutputDir: defaultRecordingsDir,
    onWarning: (message, sessionRef) => {
      logger.warn('recording_warning', {
        message,
        sessionId: sessionRef?.sessionId,
        outputDir: sessionRef?.outputDir,
      });
      emitRecordingStatus({
        kind: 'warning',
        message,
        ...(sessionRef ? { sessionId: sessionRef.sessionId, outputDir: sessionRef.outputDir } : {}),
      });
    },
  });

  // `manager` is reassigned on each Start (after teardown of any prior session).
  // eslint can't see the closure-mutation pattern, so we suppress prefer-const.
  // eslint-disable-next-line prefer-const
  let manager: SessionManager | undefined;
  let liveRecording: RecordingSession | undefined;

  // Test Translation (M4 Phase E). Each direction is an independent OpenAISession
  // started with its own source/target language pair; translated audio is forwarded
  // to setupView (via dynamic `test:audio:${direction}` channel) so the renderer can
  // route it to the desired playback device. Playback streams are reused across
  // chunks of a single test run and torn down on stop.
  const testSessions = new TestSessionRegistry();
  const testRecordings = new Map<Direction, RecordingSession>();
  const liveTestStreams = new Map<Direction, string>();
  // Promise (not boolean) so concurrent chunks all await the SAME startPlayback
  // call — otherwise the first chunk awaits, the second/third see flag=false
  // and fire duplicate startPlayback calls; the offscreen registry tears down
  // the first handle when the second arrives, so chunks pushed in between get
  // dropped → choppy audio. With the Promise, every chunk waits for the same
  // resolution before pushing.
  const testPlaybacks = new Map<string, Promise<void>>();

  const runTestPlayback = async (
    direction: Direction,
    deviceId: string,
    base64: string,
  ): Promise<void> => {
    const streamId = `test-${direction}`;
    let p = testPlaybacks.get(streamId);
    if (!p) {
      p = offscreenBridge.startPlayback(streamId, deviceId);
      testPlaybacks.set(streamId, p);
    }
    await p;
    offscreenBridge.pushPlayback(streamId, base64);
  };

  const stopLiveTest = async (direction: Direction): Promise<void> => {
    testSessions.stop(direction);
    const streamId = liveTestStreams.get(direction);
    if (streamId) {
      offscreenBridge.stopStream(streamId);
      liveTestStreams.delete(direction);
    }
    const recording = testRecordings.get(direction);
    if (recording) {
      testRecordings.delete(direction);
      await recording.stop();
      emitRecordingStatus({ kind: 'idle' });
    }
  };

  const startTestRecording = (
    direction: Direction,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    recordingEnabled: boolean | undefined,
  ): RecordingSession | undefined => {
    const prefs = normalizeRecordingPrefs(prefsStore.load().recording);
    const testPrefs = normalizeRecordingPrefs({
      ...prefs,
      enabled: Boolean(recordingEnabled),
      directionA: direction === 'A',
      directionB: direction === 'B',
    });
    if (!recordingEnabled || !recordingHasAnyArtifact(testPrefs)) return undefined;
    const recording = recordingManager.start({
      prefs: testPrefs,
      sessionType: 'test',
      sourceLang,
      targetLang,
      directions: [direction],
    });
    if (recording) {
      testRecordings.set(direction, recording);
      emitRecordingStatus({
        kind: 'active',
        sessionId: recording.sessionId,
        sessionType: 'test',
        outputDir: recording.outputDir,
      });
    }
    return recording;
  };

  // Auto-update wiring. Skipped in dev (app.isPackaged false). In production,
  // setupAutoUpdate registers listeners on autoUpdater that broadcast version
  // info to the FloatingWidget + SetupView so they can show "update available"
  // / "update ready to install" badges. The user can click the badge (Task 7
  // wires the UI) to invoke ApplyUpdate, which calls quitAndInstall(). Or
  // they can just close the app naturally — autoInstallOnAppQuit=true applies
  // the update on next quit.
  const updater = setupAutoUpdate({
    onAvailable: (version) => broadcast(IPC.UpdateAvailable, { version }),
    onDownloaded: (version) => broadcast(IPC.UpdateDownloaded, { version }),
  });

  registerIpcHandlers({
    configStore,
    prefsStore,
    onStart: async (args) => {
      // If a previous session is still running (e.g., user clicked Start twice), tear it
      // down first so we don't leak resources or double-bind IPC channels.
      if (manager) {
        await manager.stop();
        manager = undefined;
      }
      const apiKey = configStore.getApiKey();
      if (!apiKey) {
        const message = 'No API key configured';
        emitDirectionalState({ direction: 'A', state: { kind: 'error', message } });
        emitDirectionalState({ direction: 'B', state: { kind: 'error', message } });
        throw new Error(message);
      }
      const prefs = prefsStore.load();
      liveRecording = recordingManager.start({
        prefs: normalizeRecordingPrefs(prefs.recording),
        sessionType: 'live',
        sourceLang: args.sourceLang,
        targetLang: args.targetLang,
      });
      if (liveRecording) {
        emitRecordingStatus({
          kind: 'active',
          sessionId: liveRecording.sessionId,
          sessionType: 'live',
          outputDir: liveRecording.outputDir,
        });
      }
      manager = new SessionManager({
        apiKey,
        sourceLang: args.sourceLang,
        targetLang: args.targetLang,
        micDeviceId: args.micDeviceId,
        toMeetDeviceId: args.toMeetDeviceId,
        fromMeetDeviceId: args.fromMeetDeviceId,
        headsetDeviceId: args.headsetDeviceId,
        offscreen: offscreenBridge,
        wsFactory,
        onDirectionalState: emitDirectionalState,
        onTranscript: emitTranscript,
        onLatencyMeasured: emitLatency,
        onSilenceGateMetrics: emitSilenceGateMetrics,
        ...(prefs.silenceGate ? { silenceGate: prefs.silenceGate } : {}),
        ...(liveRecording ? { recordingSession: liveRecording } : {}),
        logger,
      });
      try {
        await manager.start();
      } catch (err) {
        // Per SessionManager contract: rejection means surviving direction may still be
        // running. Tear it down before letting the error propagate. Wrap stop() so a
        // secondary failure during cleanup doesn't mask the original start error.
        try {
          await manager.stop();
        } catch (stopErr) {
          logger.error('session_manager_stop_failed', {
            message: stopErr instanceof Error ? stopErr.message : String(stopErr),
          });
        }
        manager = undefined;
        if (liveRecording) {
          await liveRecording.stop().catch((stopErr: unknown) => {
            logger.warn('recording_stop_failed', {
              message: stopErr instanceof Error ? stopErr.message : String(stopErr),
            });
          });
          liveRecording = undefined;
          emitRecordingStatus({ kind: 'idle' });
        }
        throw err;
      }
    },
    onStop: async () => {
      if (!manager) return;
      await manager.stop();
      manager = undefined;
      if (liveRecording) {
        await liveRecording.stop();
        liveRecording = undefined;
        emitRecordingStatus({ kind: 'idle' });
      }
    },
    listDevices: () => buildDeviceInventory(offscreenWindow!),
    openSetupView: async () => {
      // Post-setup gear opens the review screen; pre-setup callers don't reach
      // this IPC (the wizard auto-opens at startup via createWindows).
      await createSetupView('#/review');
    },
    onSetupComplete: async () => {
      await createFloatingWidget(prefsStore);
      if (setupView && !setupView.isDestroyed()) setupView.close();
    },
    showBarMenu: (sender) => {
      const win = BrowserWindow.fromWebContents(sender);
      if (!win) return;
      const locale = resolveLocale(prefsStore);
      const t = createT(getDictionary(locale));
      const menu = Menu.buildFromTemplate([
        { label: t('menu.settings'), click: () => { void createSetupView('#/review'); } },
        { type: 'separator' },
        { label: t('menu.quit'), accelerator: 'Alt+F4', click: () => app.quit() },
      ]);
      menu.popup({ window: win });
    },
    setBarMouseEvents: ({ ignore }) => {
      if (floatingWidget && !floatingWidget.isDestroyed()) {
        floatingWidget.setIgnoreMouseEvents(ignore, { forward: true });
      }
    },
    quitApp: () => app.quit(),
    openExternalUrl: async (url) => {
      const parsed = validateExternalUrl(url);
      await shell.openExternal(parsed.toString());
    },
    chooseRecordingOutputDir: async () => {
      const result = await dialog.showOpenDialog({
        title: 'Choose recordings folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    openRecordingOutputDir: async (dir) => {
      const target = dir || defaultRecordingsDir;
      mkdirSync(target, { recursive: true });
      await shell.openPath(target);
    },
    resolveLocale: () => resolveLocale(prefsStore),
    testSessionStart: ({ direction, sourceLang, targetLang, recordingEnabled }) => {
      const apiKey = configStore.getApiKey();
      if (!apiKey) throw new Error('No API key');
      if (liveTestStreams.has(direction)) {
        void stopLiveTest(direction);
      }
      const existing = testRecordings.get(direction);
      if (existing) {
        testRecordings.delete(direction);
        void existing.stop().catch((err: unknown) => {
          logger.warn('test_recording_stop_failed', {
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
      startTestRecording(direction, sourceLang, targetLang, recordingEnabled);
      testSessions.start(direction, sourceLang, targetLang, {
        apiKey,
        wsFactory,
        onAudio: (b64) => {
          testRecordings.get(direction)?.recordOutput(direction, b64);
          if (setupView && !setupView.isDestroyed()) {
            setupView.webContents.send(`test:audio:${direction}`, b64);
          }
        },
      });
    },
    testSessionInject: ({ direction, base64 }) => {
      testRecordings.get(direction)?.recordInput(direction, base64);
      testSessions.inject(direction, base64);
    },
    testSessionInputDone: ({ direction }) => testSessions.inputDone(direction),
    testSessionStop: async ({ direction }) => {
      testSessions.stop(direction);
      const streamId = `test-${direction}`;
      offscreenBridge.stopStream(streamId);
      testPlaybacks.delete(streamId);
      const recording = testRecordings.get(direction);
      if (recording) {
        testRecordings.delete(direction);
        await recording.stop();
        emitRecordingStatus({ kind: 'idle' });
      }
    },
    testLiveStart: async ({
      direction,
      sourceLang,
      targetLang,
      inputDeviceId,
      outputDeviceId,
      recordingEnabled,
    }) => {
      const apiKey = configStore.getApiKey();
      if (!apiKey) throw new Error('No API key');
      await stopLiveTest(direction);
      const streamId = `test-live-${direction}`;
      liveTestStreams.set(direction, streamId);
      const silenceGatePrefs = prefsStore.load().silenceGate;
      const silenceGate = new LocalSilenceGate(
        silenceGatePrefs ? { prefs: silenceGatePrefs } : {},
      );
      startTestRecording(direction, sourceLang, targetLang, recordingEnabled);
      testSessions.start(direction, sourceLang, targetLang, {
        apiKey,
        wsFactory,
        onAudio: (b64) => {
          testRecordings.get(direction)?.recordOutput(direction, b64);
          setupView?.webContents.send(`test:livePcm:${direction}`, {
            kind: 'output',
            base64: b64,
          });
          offscreenBridge.pushPlayback(streamId, b64);
        },
      });
      await offscreenBridge.startPlayback(streamId, outputDeviceId);
      try {
        await offscreenBridge.startCapture(streamId, inputDeviceId, (b64) => {
          testRecordings.get(direction)?.recordInput(direction, b64);
          setupView?.webContents.send(`test:livePcm:${direction}`, {
            kind: 'input',
            base64: b64,
          });
          for (const chunk of silenceGate.process(direction, b64)) {
            testSessions.inject(direction, chunk);
          }
          emitSilenceGateMetrics(silenceGate.snapshot());
        });
      } catch (err) {
        await stopLiveTest(direction);
        throw err;
      }
    },
    testLiveStop: ({ direction }) => stopLiveTest(direction),
    runLoopback: (deviceId, thresholdRms, timeoutMs) =>
      runLoopback(offscreenWindow!, deviceId, thresholdRms, timeoutMs),
    runTestPlayback: (direction, deviceId, base64) =>
      runTestPlayback(direction, deviceId, base64),
    applyUpdate: async () => {
      updater.quitAndInstall();
    },
  });

  app.on('before-quit', () => {
    void Promise.all([
      manager?.stop(),
      liveRecording?.stop(),
      ...Array.from(testRecordings.values()).map((recording) => recording.stop()),
    ]).catch((err: unknown) => {
      logger.warn('recording_before_quit_cleanup_failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  // 5-second delay so the auto-update check doesn't compete with first-launch
  // wizard mounting. setTimeout is fire-and-forget — checkNow swallows its own
  // errors so a network blip can't take down the main process.
  setTimeout(() => {
    void updater.checkNow();
  }, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await logSink?.close();
});
