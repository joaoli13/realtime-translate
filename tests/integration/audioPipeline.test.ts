import { describe, it, expect, beforeEach } from 'vitest';
import { AudioPipeline, type OffscreenController, type SessionLike } from '@main/translate/audioPipeline';

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
    // Mirror production OffscreenBridge.stopStream behavior.
    this.stoppedStreams.add(streamId);
    this.pcmCallbacks.delete(streamId);
  }
  stopAll(): void {
    this.stoppedAll = true;
  }
}

class FakeSession implements SessionLike {
  appendCalls: string[] = [];
  startCalled = false;
  stopCalled = false;
  start() {
    this.startCalled = true;
  }
  appendAudio(b64: string) {
    this.appendCalls.push(b64);
  }
  stop() {
    this.stopCalled = true;
  }
}

describe('AudioPipeline', () => {
  let offscreen: FakeOffscreen;
  let session: FakeSession;
  let pipeline: AudioPipeline;

  beforeEach(() => {
    offscreen = new FakeOffscreen();
    session = new FakeSession();
    pipeline = new AudioPipeline({
      streamId: 'A',
      offscreen,
      session,
      micDeviceId: 'mic-123',
      outputDeviceId: 'cable-a-456',
    });
  });

  it('start() initializes capture, playback, and the session for its streamId', async () => {
    await pipeline.start();
    expect(offscreen.startCaptureCalled.get('A')).toBe('mic-123');
    expect(offscreen.startPlaybackCalled.get('A')).toBe('cable-a-456');
    expect(session.startCalled).toBe(true);
  });

  it('forwards captured PCM chunks to session.appendAudio', async () => {
    await pipeline.start();
    offscreen.pcmCallbacks.get('A')?.('chunk1');
    offscreen.pcmCallbacks.get('A')?.('chunk2');
    expect(session.appendCalls).toEqual(['chunk1', 'chunk2']);
  });

  it('mirrors captured and output PCM to optional recording hooks', async () => {
    const input: string[] = [];
    const output: string[] = [];
    const p = new AudioPipeline({
      streamId: 'A',
      offscreen,
      session,
      micDeviceId: 'mic-123',
      outputDeviceId: 'cable-a-456',
      onInputPcm: (b64) => input.push(b64),
      onOutputPcm: (b64) => output.push(b64),
    });
    await p.start();
    offscreen.pcmCallbacks.get('A')?.('in-1');
    p.handleSessionAudio('out-1');
    expect(input).toEqual(['in-1']);
    expect(output).toEqual(['out-1']);
    expect(session.appendCalls).toEqual(['in-1']);
    expect(offscreen.pushedAudio.get('A')).toEqual(['out-1']);
  });

  it('lets a local send policy suppress OpenAI append without suppressing input recording', async () => {
    const input: string[] = [];
    const sent: string[] = [];
    const p = new AudioPipeline({
      streamId: 'A',
      offscreen,
      session,
      micDeviceId: 'mic-123',
      outputDeviceId: 'cable-a-456',
      onInputPcm: (b64) => input.push(b64),
      sendInputPcm: (b64) => {
        if (b64 !== 'silent') session.appendAudio(b64);
        sent.push(b64);
      },
    });
    await p.start();
    offscreen.pcmCallbacks.get('A')?.('silent');
    offscreen.pcmCallbacks.get('A')?.('speech');
    expect(input).toEqual(['silent', 'speech']);
    expect(sent).toEqual(['silent', 'speech']);
    expect(session.appendCalls).toEqual(['speech']);
  });

  it('forwards session audio deltas to offscreen playback for its streamId', async () => {
    await pipeline.start();
    pipeline.handleSessionAudio('output-chunk-1');
    pipeline.handleSessionAudio('output-chunk-2');
    expect(offscreen.pushedAudio.get('A')).toEqual(['output-chunk-1', 'output-chunk-2']);
  });

  it("stop() stops session and the pipeline's stream only", async () => {
    await pipeline.start();
    pipeline.stop();
    expect(session.stopCalled).toBe(true);
    expect(offscreen.stoppedStreams.has('A')).toBe(true);
    expect(offscreen.stoppedAll).toBe(false);
  });

  it('rolls back offscreen on capture init failure (stops the same stream only)', async () => {
    class FailingOffscreen extends FakeOffscreen {
      override async startCapture(): Promise<void> {
        throw new Error('mic permission denied');
      }
    }
    const failing = new FailingOffscreen();
    const p = new AudioPipeline({
      streamId: 'A',
      offscreen: failing,
      session,
      micDeviceId: 'mic-x',
      outputDeviceId: 'cable-x',
    });
    await expect(p.start()).rejects.toThrow('mic permission denied');
    expect(failing.startPlaybackCalled.get('A')).toBe('cable-x');
    expect(failing.stoppedStreams.has('A')).toBe(true);
    expect(session.startCalled).toBe(false);
  });
});
