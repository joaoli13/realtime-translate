import { describe, expect, it } from 'vitest';
import { LocalSilenceGate, rmsPcm16Base64 } from '@main/translate/silenceGate';

function pcmChunk(amplitude: number, samples = 2400): string {
  const buf = Buffer.alloc(samples * 2);
  const int16 = Math.round(amplitude * 0x7fff);
  for (let offset = 0; offset < buf.byteLength; offset += 2) {
    buf.writeInt16LE(int16, offset);
  }
  return buf.toString('base64');
}

describe('LocalSilenceGate', () => {
  it('computes RMS for PCM16 base64 chunks', () => {
    expect(rmsPcm16Base64(pcmChunk(0))).toBe(0);
    expect(rmsPcm16Base64(pcmChunk(0.25))).toBeCloseTo(0.25, 2);
  });

  it('passes through all chunks when disabled', () => {
    const gate = new LocalSilenceGate({ prefs: { enabled: false } });
    const silent = pcmChunk(0);
    expect(gate.process('A', silent)).toEqual([silent]);
    expect(gate.snapshot().A.sentChunks).toBe(1);
    expect(gate.snapshot().A.suppressedChunks).toBe(0);
  });

  it('suppresses silence only after the global pause window has elapsed', () => {
    let now = 0;
    const gate = new LocalSilenceGate({
      prefs: { enabled: true },
      minGlobalSilenceMs: 300,
      hangoverMs: 0,
      preRollMs: 100,
      now: () => now,
    });
    const silent = pcmChunk(0);

    expect(gate.process('A', silent)).toHaveLength(1);
    now += 100;
    expect(gate.process('B', silent)).toHaveLength(1);
    now += 100;
    expect(gate.process('A', silent)).toHaveLength(1);
    now += 100;
    expect(gate.process('B', silent)).toHaveLength(0);

    const metrics = gate.snapshot();
    expect(metrics.globalPauseActive).toBe(true);
    expect(metrics.B.suppressedChunks).toBe(1);
  });

  it('does not classify a global pause while either direction is speaking', () => {
    let now = 0;
    const gate = new LocalSilenceGate({
      prefs: { enabled: true },
      minGlobalSilenceMs: 300,
      hangoverMs: 250,
      now: () => now,
    });
    const silent = pcmChunk(0);
    const speech = pcmChunk(0.05);

    for (let i = 0; i < 8; i++) {
      expect(gate.process('A', speech)).toHaveLength(1);
      now += 100;
      expect(gate.process('B', silent)).toHaveLength(1);
      now += 100;
    }

    const metrics = gate.snapshot();
    expect(metrics.globalPauseActive).toBe(false);
    expect(metrics.A.suppressedChunks + metrics.B.suppressedChunks).toBe(0);
  });

  it('sends pre-roll when speech resumes after a global pause', () => {
    let now = 0;
    const gate = new LocalSilenceGate({
      prefs: { enabled: true },
      minGlobalSilenceMs: 100,
      hangoverMs: 0,
      preRollMs: 250,
      now: () => now,
    });
    const silent = pcmChunk(0);
    const speech = pcmChunk(0.05);

    gate.process('A', silent);
    now += 100;
    gate.process('B', silent);
    now += 100;
    expect(gate.process('A', silent)).toHaveLength(0);
    now += 100;
    expect(gate.process('A', speech).length).toBeGreaterThan(1);
  });
});
