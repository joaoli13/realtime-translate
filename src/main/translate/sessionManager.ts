import type { OffscreenController } from './audioPipeline';
import { AudioPipeline } from './audioPipeline';
import { OpenAISession, type WebSocketFactory } from './openaiSession';
import { normalizeSilenceGatePrefs } from '../../shared/types';
import type { Direction, SessionState, SilenceGateMetrics, SilenceGatePrefs } from '../../shared/types';
import type { LanguageCode } from '../../shared/languages';
import type { Logger } from '../util/logger';
import type { RecordingSession } from '../recording/recordingManager';
import { LocalSilenceGate } from './silenceGate';

export interface SessionManagerConfig {
  apiKey: string;
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  micDeviceId: string;
  toMeetDeviceId: string;
  fromMeetDeviceId: string;
  headsetDeviceId: string;
  offscreen: OffscreenController;
  wsFactory: WebSocketFactory;
  onDirectionalState: (s: { direction: Direction; state: SessionState }) => void;
  onTranscript: (t: { direction: Direction; kind: 'input' | 'output'; text: string }) => void;
  onLatencyMeasured: (m: { direction: Direction; averageMs: number; sampleCount: number }) => void;
  onSilenceGateMetrics?: (m: SilenceGateMetrics) => void;
  silenceGate?: Partial<SilenceGatePrefs>;
  recordingSession?: RecordingSession;
  logger?: Logger;
}

interface DirectionContext {
  session: OpenAISession;
  pipeline: AudioPipeline;
}

export class SessionManager {
  private a: DirectionContext | undefined;
  private b: DirectionContext | undefined;
  private silenceGate: LocalSilenceGate | undefined;
  private lastSilenceGateMetricsEmitMs = 0;

  constructor(private readonly cfg: SessionManagerConfig) {}

  /**
   * Starts both directions in parallel.
   *
   * **Caller contract on rejection:** if `start()` rejects, the surviving direction
   * may still be running (degraded mode per spec §7). Callers MUST call `stop()` to
   * tear down the surviving direction's resources. Per-direction error state is also
   * delivered via `onDirectionalState` for both directions independently.
   *
   * If both directions succeed, `start()` resolves once both are `active`.
   */
  async start(): Promise<void> {
    this.silenceGate = new LocalSilenceGate({
      prefs: normalizeSilenceGatePrefs(this.cfg.silenceGate),
    });
    this.emitSilenceGateMetrics(true);
    this.a = this.buildDirection(
      'A',
      this.cfg.sourceLang,
      this.cfg.targetLang,
      this.cfg.micDeviceId,
      this.cfg.toMeetDeviceId,
    );
    this.b = this.buildDirection(
      'B',
      this.cfg.targetLang,
      this.cfg.sourceLang,
      this.cfg.fromMeetDeviceId,
      this.cfg.headsetDeviceId,
    );

    // Start both pipelines in parallel; if one fails, surface its error via state and rethrow.
    // The other pipeline's state is independent — no automatic teardown of the surviving direction.
    const results = await Promise.allSettled([
      this.startDirection('A', this.a.pipeline),
      this.startDirection('B', this.b.pipeline),
    ]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      throw failures[0]!.reason;
    }
  }

  private async startDirection(direction: Direction, pipeline: AudioPipeline): Promise<void> {
    try {
      await pipeline.start();
    } catch (err) {
      // Pipeline init failed before session.start() — emit an error state so the UI can
      // reflect this direction's failure (degraded mode, spec §7).
      const message = err instanceof Error ? err.message : String(err);
      this.cfg.onDirectionalState({ direction, state: { kind: 'error', message } });
      throw err;
    }
  }

  async stop(): Promise<void> {
    // Pipeline.stop() is sync today (interface returns void), but `await Promise.all` is
    // future-proof: if the offscreen-controller stopStream ever becomes async, no churn here.
    await Promise.all([this.a?.pipeline.stop(), this.b?.pipeline.stop()]);
    this.a = undefined;
    this.b = undefined;
    this.emitSilenceGateMetrics(true);
  }

  private buildDirection(
    direction: Direction,
    source: LanguageCode,
    target: LanguageCode,
    micDeviceId: string,
    outputDeviceId: string,
  ): DirectionContext {
    // Circular ref: session.events.onAudio needs to reach pipeline.handleSessionAudio,
    // but pipeline construction needs the session as a dep. Bind via mutable ref captured
    // by the closure, set after pipeline construction. Don't "simplify" by inlining —
    // it would break audio routing silently (closure would capture undefined).
    // eslint-disable-next-line prefer-const
    let pipelineRef: AudioPipeline | undefined;
    const session = new OpenAISession({
      apiKey: this.cfg.apiKey,
      sourceLang: source,
      targetLang: target,
      events: {
        onState: (s) => this.cfg.onDirectionalState({ direction, state: s }),
        onAudio: (b64) => pipelineRef?.handleSessionAudio(b64),
        onTranscript: (t) =>
          this.cfg.onTranscript({ direction, kind: t.kind, text: t.text }),
        onLatencyMeasured: (m) =>
          this.cfg.onLatencyMeasured({ direction, ...m }),
      },
      wsFactory: this.cfg.wsFactory,
      ...(this.cfg.logger ? { logger: this.cfg.logger } : {}),
    });
    const pipeline = new AudioPipeline({
      streamId: direction,
      offscreen: this.cfg.offscreen,
      session,
      micDeviceId,
      outputDeviceId,
      onInputPcm: (b64) => this.cfg.recordingSession?.recordInput(direction, b64),
      onOutputPcm: (b64) => this.cfg.recordingSession?.recordOutput(direction, b64),
      sendInputPcm: (b64) => {
        const chunks = this.silenceGate?.process(direction, b64) ?? [b64];
        for (const chunk of chunks) session.appendAudio(chunk);
        this.emitSilenceGateMetrics(chunks.length === 0);
      },
    });
    pipelineRef = pipeline;
    return { session, pipeline };
  }

  private emitSilenceGateMetrics(force = false): void {
    if (!this.silenceGate || !this.cfg.onSilenceGateMetrics) return;
    const now = Date.now();
    if (!force && now - this.lastSilenceGateMetricsEmitMs < 1000) return;
    this.lastSilenceGateMetricsEmitMs = now;
    this.cfg.onSilenceGateMetrics(this.silenceGate.snapshot());
  }
}
