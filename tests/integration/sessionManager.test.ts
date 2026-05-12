import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SessionManager,
  type SessionManagerConfig,
} from '@main/translate/sessionManager';
import type { OffscreenController } from '@main/translate/audioPipeline';
import type { Direction, SessionState } from '@shared/types';
import type { WebSocketLike, WebSocketFactory } from '@main/translate/openaiSession';

function pcmChunk(amplitude: number, samples = 2400): string {
  const buf = Buffer.alloc(samples * 2);
  const int16 = Math.round(amplitude * 0x7fff);
  for (let offset = 0; offset < buf.byteLength; offset += 2) {
    buf.writeInt16LE(int16, offset);
  }
  return buf.toString('base64');
}

function inputAppends(ws: FakeWebSocket): unknown[] {
  return ws.sent
    .map((raw) => JSON.parse(raw) as { type: string })
    .filter((msg) => msg.type === 'session.input_audio_buffer.append');
}

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen?: () => void;
  onclose?: (code: number, reason: string) => void;
  onmessage?: (data: string) => void;
  onerror?: (err: Error) => void;
  constructor(public url: string, public headers: Record<string, string>) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.(code ?? 1000, reason ?? '');
  }
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  simulateError(err: Error): void {
    this.onerror?.(err);
  }
}

class FakeOffscreen implements OffscreenController {
  startCaptureCalled = new Map<string, string>();
  startPlaybackCalled = new Map<string, string>();
  pushedAudio = new Map<string, string[]>();
  pcmCallbacks = new Map<string, (b64: string) => void>();
  stoppedStreams = new Set<string>();
  stoppedAll = false;

  async startCapture(
    streamId: string,
    deviceId: string,
    onPcm: (b64: string) => void,
  ): Promise<void> {
    this.startCaptureCalled.set(streamId, deviceId);
    this.pcmCallbacks.set(streamId, onPcm);
  }
  async startPlayback(streamId: string, deviceId: string): Promise<void> {
    this.startPlaybackCalled.set(streamId, deviceId);
  }
  pushPlayback(streamId: string, b64: string): void {
    const list = this.pushedAudio.get(streamId) ?? [];
    list.push(b64);
    this.pushedAudio.set(streamId, list);
  }
  stopStream(streamId: string): void {
    // Mirror production OffscreenBridge.stopStream — clear per-stream callback so
    // the fake doesn't drift from real behavior in a future test that asserts post-stop
    // state (e.g., reconnect tests in M3+).
    this.stoppedStreams.add(streamId);
    this.pcmCallbacks.delete(streamId);
  }
  stopAll(): void {
    this.stoppedAll = true;
  }
}

describe('SessionManager', () => {
  let offscreen: FakeOffscreen;
  let onState: ReturnType<typeof vi.fn>;
  let onTranscript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useRealTimers();
    FakeWebSocket.instances = [];
    offscreen = new FakeOffscreen();
    onState = vi.fn();
    onTranscript = vi.fn();
  });

  const buildConfig = (overrides: Partial<SessionManagerConfig> = {}): SessionManagerConfig => {
    const wsFactory: WebSocketFactory = (url, headers) => new FakeWebSocket(url, headers);
    return {
      apiKey: 'sk-test',
      sourceLang: 'pt',
      targetLang: 'en',
      micDeviceId: 'mic',
      toMeetDeviceId: 'cableA-input',
      fromMeetDeviceId: 'cableB-output',
      headsetDeviceId: 'headset',
      offscreen,
      wsFactory,
      onDirectionalState: onState as (s: { direction: Direction; state: SessionState }) => void,
      onTranscript: onTranscript as (t: {
        direction: Direction;
        kind: 'input' | 'output';
        text: string;
      }) => void,
      onLatencyMeasured: vi.fn(),
      ...overrides,
    };
  };

  it('start() opens both sessions and configures both pipelines', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    // 2 sockets opened
    expect(FakeWebSocket.instances).toHaveLength(2);
    // streams A and B are configured
    expect(offscreen.startCaptureCalled.get('A')).toBe('mic');
    expect(offscreen.startPlaybackCalled.get('A')).toBe('cableA-input');
    expect(offscreen.startCaptureCalled.get('B')).toBe('cableB-output');
    expect(offscreen.startPlaybackCalled.get('B')).toBe('headset');
  });

  it('emits per-direction state transitions', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    expect(onState).toHaveBeenCalledWith({ direction: 'A', state: { kind: 'connecting' } });
    expect(onState).toHaveBeenCalledWith({ direction: 'B', state: { kind: 'connecting' } });
    FakeWebSocket.instances[0]!.simulateOpen();
    FakeWebSocket.instances[1]!.simulateOpen();
    const lastA = onState.mock.calls
      .map((c) => c[0])
      .filter((s) => (s as { direction: Direction }).direction === 'A')
      .pop();
    expect((lastA as { state: SessionState }).state.kind).toBe('active');
  });

  it('routes session A audio deltas to stream A playback', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    const wsA = FakeWebSocket.instances[0]!;
    wsA.simulateOpen();
    // Server sends audio delta to A
    wsA.onmessage?.(JSON.stringify({ type: 'session.output_audio.delta', delta: 'a-out' }));
    expect(offscreen.pushedAudio.get('A')).toEqual(['a-out']);
    expect(offscreen.pushedAudio.get('B') ?? []).toEqual([]);
    void mgr;
  });

  it('mirrors input and output audio to the configured recording session', async () => {
    const recording = {
      recordInput: vi.fn(),
      recordOutput: vi.fn(),
    };
    const mgr = new SessionManager(buildConfig({
      recordingSession: recording as never,
    }));
    await mgr.start();
    offscreen.pcmCallbacks.get('A')?.('a-in');
    const wsA = FakeWebSocket.instances[0]!;
    wsA.simulateOpen();
    wsA.onmessage?.(JSON.stringify({ type: 'session.output_audio.delta', delta: 'a-out' }));
    expect(recording.recordInput).toHaveBeenCalledWith('A', 'a-in');
    expect(recording.recordOutput).toHaveBeenCalledWith('A', 'a-out');
  });

  it('silence gate suppresses only after both directions are in a long pause', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const metrics = vi.fn();
    const recording = {
      recordInput: vi.fn(),
      recordOutput: vi.fn(),
    };
    const mgr = new SessionManager(buildConfig({
      silenceGate: { enabled: true },
      onSilenceGateMetrics: metrics,
      recordingSession: recording as never,
    }));
    await mgr.start();
    const wsA = FakeWebSocket.instances[0]!;
    const wsB = FakeWebSocket.instances[1]!;
    wsA.simulateOpen();
    wsB.simulateOpen();

    const silent = pcmChunk(0);
    offscreen.pcmCallbacks.get('A')?.(silent);
    offscreen.pcmCallbacks.get('B')?.(silent);
    expect(inputAppends(wsA)).toHaveLength(1);
    expect(inputAppends(wsB)).toHaveLength(1);

    vi.setSystemTime(3500);
    offscreen.pcmCallbacks.get('A')?.(silent);
    offscreen.pcmCallbacks.get('B')?.(silent);
    expect(inputAppends(wsA)).toHaveLength(1);
    expect(inputAppends(wsB)).toHaveLength(1);
    expect(recording.recordInput).toHaveBeenCalledWith('A', silent);
    expect(recording.recordInput).toHaveBeenCalledWith('B', silent);
    expect(metrics).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true,
      globalPauseActive: true,
    }));

    await mgr.stop();
    vi.useRealTimers();
  });

  it('silence gate keeps both directions flowing while either side is speaking', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const mgr = new SessionManager(buildConfig({
      silenceGate: { enabled: true },
    }));
    await mgr.start();
    const wsA = FakeWebSocket.instances[0]!;
    const wsB = FakeWebSocket.instances[1]!;
    wsA.simulateOpen();
    wsB.simulateOpen();

    const silent = pcmChunk(0);
    const speech = pcmChunk(0.05);
    for (let t = 0; t <= 4000; t += 500) {
      vi.setSystemTime(t);
      offscreen.pcmCallbacks.get('A')?.(speech);
      offscreen.pcmCallbacks.get('B')?.(silent);
    }

    expect(inputAppends(wsA).length).toBeGreaterThan(1);
    expect(inputAppends(wsB).length).toBeGreaterThan(1);
    expect(inputAppends(wsA)).toHaveLength(inputAppends(wsB).length);

    await mgr.stop();
    vi.useRealTimers();
  });

  it('routes session B audio deltas to stream B playback', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    const wsB = FakeWebSocket.instances[1]!;
    wsB.simulateOpen();
    wsB.onmessage?.(JSON.stringify({ type: 'session.output_audio.delta', delta: 'b-out' }));
    expect(offscreen.pushedAudio.get('B')).toEqual(['b-out']);
    expect(offscreen.pushedAudio.get('A') ?? []).toEqual([]);
    void mgr;
  });

  it('one direction failing does not stop the other (degraded mode)', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    const wsA = FakeWebSocket.instances[0]!;
    const wsB = FakeWebSocket.instances[1]!;
    wsA.simulateOpen();
    wsB.simulateOpen();
    // Server-side error on A
    wsA.onmessage?.(
      JSON.stringify({ type: 'error', error: { message: 'A failed' } }),
    );
    // Last emitted A state is error; B state is still active
    const aStates = onState.mock.calls
      .map((c) => c[0])
      .filter((s) => (s as { direction: Direction }).direction === 'A');
    expect((aStates[aStates.length - 1] as { state: SessionState }).state.kind).toBe('error');
    const bStates = onState.mock.calls
      .map((c) => c[0])
      .filter((s) => (s as { direction: Direction }).direction === 'B');
    expect((bStates[bStates.length - 1] as { state: SessionState }).state.kind).toBe('active');
  });

  it('stop() tears down both sessions and both streams', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    FakeWebSocket.instances[0]!.simulateOpen();
    FakeWebSocket.instances[1]!.simulateOpen();
    await mgr.stop();
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
    expect(FakeWebSocket.instances[1]!.closed).toBe(true);
    expect(offscreen.stoppedStreams.has('A')).toBe(true);
    expect(offscreen.stoppedStreams.has('B')).toBe(true);
  });

  it('start() throws and emits error on direction A if pipeline A startCapture fails', async () => {
    class FailingOffscreenA extends FakeOffscreen {
      override async startCapture(
        streamId: string,
        deviceId: string,
        onPcm: (b64: string) => void,
      ): Promise<void> {
        if (streamId === 'A') throw new Error('A capture failed');
        return super.startCapture(streamId, deviceId, onPcm);
      }
    }
    const offA = new FailingOffscreenA();
    const mgr = new SessionManager(buildConfig({ offscreen: offA }));
    await expect(mgr.start()).rejects.toThrow();
    const aStates = onState.mock.calls
      .map((c) => c[0])
      .filter((s) => (s as { direction: Direction }).direction === 'A');
    expect((aStates[aStates.length - 1] as { state: SessionState }).state.kind).toBe('error');
  });
});
