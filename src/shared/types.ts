import type { LanguageCode } from './languages';

export type SessionState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'active'; sinceMs: number }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'error'; message: string };

export interface DeviceSummary {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

export type AudioPlatform = 'win32' | 'darwin' | 'linux' | 'unknown';
export type VirtualAudioProvider = 'vb-cable' | 'blackhole' | 'loopback' | 'soundflower' | 'manual';

export interface VirtualRoutePairSummary {
  label?: string;
  provider?: VirtualAudioProvider;
  playback?: DeviceSummary;
  recording?: DeviceSummary;
}

// Renderer-facing twin of the main-process CablePair from src/main/audio/deviceDetector.ts.
// Uses DeviceSummary instead of DeviceInfo so this type can live in `shared` without pulling
// in main-only code. Main process maps DeviceInfo -> DeviceSummary at the IPC boundary.
export interface DeviceInventory {
  platform?: AudioPlatform;
  inputs: DeviceSummary[];
  outputs: DeviceSummary[];
  virtualInputs?: DeviceSummary[];
  virtualOutputs?: DeviceSummary[];
  cableA?: VirtualRoutePairSummary;
  cableB?: VirtualRoutePairSummary;
}

export type Direction = 'A' | 'B';

export interface RecordingPrefs {
  enabled: boolean;
  includeInput: boolean;
  includeOutput: boolean;
  includeMixed: boolean;
  mixedInputPercent: number;
  directionA: boolean;
  directionB: boolean;
  outputDir?: string | null;
}

export interface SilenceGatePrefs {
  enabled: boolean;
}

export interface SilenceGateDirectionMetrics {
  sentChunks: number;
  suppressedChunks: number;
  sentMs: number;
  suppressedMs: number;
}

export interface SilenceGateMetrics {
  enabled: boolean;
  globalPauseActive: boolean;
  A: SilenceGateDirectionMetrics;
  B: SilenceGateDirectionMetrics;
}

export type RecordingStatus =
  | { kind: 'idle' }
  | { kind: 'active'; sessionId: string; sessionType: 'live' | 'test'; outputDir: string }
  | { kind: 'warning'; message: string; sessionId?: string; outputDir?: string };

export interface WaveformSample {
  input: number;
  output: number;
}

export const DEFAULT_RECORDING_PREFS: RecordingPrefs = {
  enabled: false,
  includeInput: true,
  includeOutput: true,
  includeMixed: false,
  mixedInputPercent: 20,
  directionA: true,
  directionB: true,
  outputDir: null,
};

export const DEFAULT_SILENCE_GATE_PREFS: SilenceGatePrefs = {
  enabled: false,
};

export function normalizeRecordingPrefs(value: Partial<RecordingPrefs> | undefined): RecordingPrefs {
  const merged = { ...DEFAULT_RECORDING_PREFS, ...(value ?? {}) };
  const mixedInputPercent = Number.isFinite(merged.mixedInputPercent)
    ? Math.min(100, Math.max(0, Math.round(merged.mixedInputPercent)))
    : DEFAULT_RECORDING_PREFS.mixedInputPercent;
  return {
    enabled: Boolean(merged.enabled),
    includeInput: Boolean(merged.includeInput),
    includeOutput: Boolean(merged.includeOutput),
    includeMixed: Boolean(merged.includeMixed),
    mixedInputPercent,
    directionA: Boolean(merged.directionA),
    directionB: Boolean(merged.directionB),
    outputDir: merged.outputDir || null,
  };
}

export function normalizeSilenceGatePrefs(
  value: Partial<SilenceGatePrefs> | undefined,
): SilenceGatePrefs {
  return {
    enabled: Boolean(value?.enabled ?? DEFAULT_SILENCE_GATE_PREFS.enabled),
  };
}

export function recordingHasAnyArtifact(prefs: RecordingPrefs): boolean {
  return prefs.includeInput || prefs.includeOutput || prefs.includeMixed;
}

/** Per-direction state for bidirectional translation. */
export interface DirectionalState {
  direction: Direction;
  state: SessionState;
}

/**
 * Bidirectional translation startup args. Direction A = user speaks → interlocutor;
 * Direction B = interlocutor speaks → user.
 *
 * Device names from the *device's* perspective (matches Web Audio's MediaDeviceInfo.kind):
 * - micDeviceId: real mic, Direction A audio source (audioinput)
 * - toMeetDeviceId: where Direction A's translated output is played; Meet records from
 *   this cable's recording side (audiooutput, e.g., 'CABLE-A Input')
 * - fromMeetDeviceId: where the app captures Meet's incoming audio; Meet plays into
 *   this cable's playback side, app reads from the recording side (audioinput, e.g., 'CABLE-B Output')
 * - headsetDeviceId: real speakers/headphones, Direction B output (audiooutput)
 */
export interface BidirectionalArgs {
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  micDeviceId: string;
  toMeetDeviceId: string;
  fromMeetDeviceId: string;
  headsetDeviceId: string;
}
