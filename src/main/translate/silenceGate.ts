import type {
  Direction,
  SilenceGateDirectionMetrics,
  SilenceGateMetrics,
  SilenceGatePrefs,
} from '../../shared/types';
import { normalizeSilenceGatePrefs } from '../../shared/types';

export interface SilenceGateConfig {
  prefs?: Partial<SilenceGatePrefs>;
  sampleRate?: number;
  thresholdRms?: number;
  preRollMs?: number;
  hangoverMs?: number;
  minGlobalSilenceMs?: number;
  now?: () => number;
}

interface BufferedChunk {
  base64: string;
  durationMs: number;
}

interface DirectionState {
  activeUntilMs: number;
  preRoll: BufferedChunk[];
  preRollMs: number;
  metrics: SilenceGateDirectionMetrics;
}

export const DEFAULT_SILENCE_GATE_CONFIG = {
  sampleRate: 24000,
  thresholdRms: 0.01,
  preRollMs: 200,
  hangoverMs: 600,
  minGlobalSilenceMs: 3000,
} as const;

const DIRECTIONS: Direction[] = ['A', 'B'];

export class LocalSilenceGate {
  private readonly enabled: boolean;
  private readonly sampleRate: number;
  private readonly thresholdRms: number;
  private readonly preRollMs: number;
  private readonly hangoverMs: number;
  private readonly minGlobalSilenceMs: number;
  private readonly now: () => number;
  private readonly states = new Map<Direction, DirectionState>();
  private globalQuietSinceMs: number | undefined;
  private globalPauseActive = false;

  constructor(cfg: SilenceGateConfig = {}) {
    this.enabled = normalizeSilenceGatePrefs(cfg.prefs).enabled;
    this.sampleRate = cfg.sampleRate ?? DEFAULT_SILENCE_GATE_CONFIG.sampleRate;
    this.thresholdRms = cfg.thresholdRms ?? DEFAULT_SILENCE_GATE_CONFIG.thresholdRms;
    this.preRollMs = cfg.preRollMs ?? DEFAULT_SILENCE_GATE_CONFIG.preRollMs;
    this.hangoverMs = cfg.hangoverMs ?? DEFAULT_SILENCE_GATE_CONFIG.hangoverMs;
    this.minGlobalSilenceMs =
      cfg.minGlobalSilenceMs ?? DEFAULT_SILENCE_GATE_CONFIG.minGlobalSilenceMs;
    this.now = cfg.now ?? Date.now;

    for (const direction of DIRECTIONS) {
      this.states.set(direction, {
        activeUntilMs: 0,
        preRoll: [],
        preRollMs: 0,
        metrics: { sentChunks: 0, suppressedChunks: 0, sentMs: 0, suppressedMs: 0 },
      });
    }
  }

  process(direction: Direction, base64: string): string[] {
    const durationMs = durationMsForPcm16Base64(base64, this.sampleRate);
    const state = this.state(direction);

    if (!this.enabled) {
      this.noteSent(state.metrics, durationMs);
      return [base64];
    }

    const now = this.now();
    const wasGlobalPauseActive = this.globalPauseActive;
    const rms = rmsPcm16Base64(base64);
    const isSpeech = rms >= this.thresholdRms;
    const preRoll = state.preRoll;

    if (isSpeech) {
      state.activeUntilMs = now + this.hangoverMs;
      state.preRoll = [];
      state.preRollMs = 0;
      this.globalQuietSinceMs = undefined;
      this.globalPauseActive = false;
      const chunks = wasGlobalPauseActive ? [...preRoll.map((c) => c.base64), base64] : [base64];
      for (const chunk of chunks) {
        this.noteSent(state.metrics, durationMsForPcm16Base64(chunk, this.sampleRate));
      }
      return chunks;
    }

    this.pushPreRoll(state, { base64, durationMs });
    const allDirectionsQuiet = DIRECTIONS.every((d) => this.state(d).activeUntilMs <= now);
    if (!allDirectionsQuiet) {
      this.globalQuietSinceMs = undefined;
      this.globalPauseActive = false;
      this.noteSent(state.metrics, durationMs);
      return [base64];
    }

    if (this.globalQuietSinceMs === undefined) {
      this.globalQuietSinceMs = now;
    }
    this.globalPauseActive = now - this.globalQuietSinceMs >= this.minGlobalSilenceMs;
    if (!this.globalPauseActive) {
      this.noteSent(state.metrics, durationMs);
      return [base64];
    }

    this.noteSuppressed(state.metrics, durationMs);
    return [];
  }

  snapshot(): SilenceGateMetrics {
    return {
      enabled: this.enabled,
      globalPauseActive: this.globalPauseActive,
      A: { ...this.state('A').metrics },
      B: { ...this.state('B').metrics },
    };
  }

  private state(direction: Direction): DirectionState {
    return this.states.get(direction)!;
  }

  private pushPreRoll(state: DirectionState, chunk: BufferedChunk): void {
    state.preRoll.push(chunk);
    state.preRollMs += chunk.durationMs;
    while (state.preRollMs > this.preRollMs && state.preRoll.length > 0) {
      const removed = state.preRoll.shift()!;
      state.preRollMs -= removed.durationMs;
    }
  }

  private noteSent(metrics: SilenceGateDirectionMetrics, durationMs: number): void {
    metrics.sentChunks += 1;
    metrics.sentMs += Math.round(durationMs);
  }

  private noteSuppressed(metrics: SilenceGateDirectionMetrics, durationMs: number): void {
    metrics.suppressedChunks += 1;
    metrics.suppressedMs += Math.round(durationMs);
  }
}

export function durationMsForPcm16Base64(base64: string, sampleRate = 24000): number {
  const bytes = Buffer.from(base64, 'base64').byteLength;
  const samples = Math.floor(bytes / 2);
  return (samples / sampleRate) * 1000;
}

export function rmsPcm16Base64(base64: string): number {
  const buf = Buffer.from(base64, 'base64');
  if (buf.byteLength < 2) return 0;
  let sumSq = 0;
  const samples = Math.floor(buf.byteLength / 2);
  for (let offset = 0; offset + 1 < buf.byteLength; offset += 2) {
    const int16 = buf.readInt16LE(offset);
    const normalized = int16 < 0 ? int16 / 0x8000 : int16 / 0x7fff;
    sumSq += normalized * normalized;
  }
  return Math.sqrt(sumSq / samples);
}
