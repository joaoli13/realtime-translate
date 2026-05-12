import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingManager, mixPcm16 } from '@main/recording/recordingManager';
import { DEFAULT_RECORDING_PREFS } from '@shared/types';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rt-recording-'));
  tempDirs.push(dir);
  return dir;
}

function pcmBase64(samples: number[]): string {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buf.writeInt16LE(sample, index * 2));
  return buf.toString('base64');
}

function dataSize(wavPath: string): number {
  const wav = readFileSync(wavPath);
  return wav.readUInt32LE(40);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('RecordingManager', () => {
  it('writes input, output, mixed wav files and metadata', async () => {
    const manager = new RecordingManager({ defaultOutputDir: tempDir(), now: () => 0 });
    const session = manager.start({
      prefs: {
        ...DEFAULT_RECORDING_PREFS,
        enabled: true,
        includeMixed: true,
      },
      sessionType: 'live',
      sourceLang: 'pt',
      targetLang: 'en',
      directions: ['A'],
    });
    expect(session).toBeDefined();
    session!.recordInput('A', pcmBase64([1000, 1000]));
    session!.recordOutput('A', pcmBase64([2000, 2000]));
    await session!.stop();

    expect(dataSize(join(session!.outputDir, 'direction-a-input.wav'))).toBe(4);
    expect(dataSize(join(session!.outputDir, 'direction-a-output.wav'))).toBe(4);
    expect(dataSize(join(session!.outputDir, 'direction-a-mixed.wav'))).toBe(4);
    const metadata = JSON.parse(readFileSync(join(session!.outputDir, 'metadata.json'), 'utf8')) as {
      sessionType: string;
      mixedInputPercent: number;
      mixedOutputPercent: number;
      files: Array<{ kind: string; fileName: string }>;
    };
    expect(metadata.sessionType).toBe('live');
    expect(metadata.mixedInputPercent).toBe(20);
    expect(metadata.mixedOutputPercent).toBe(80);
    expect(metadata.files.map((f) => f.kind).sort()).toEqual(['input', 'mixed', 'output']);
  });

  it('supports mixed-only output without retaining separate input/output wav files', async () => {
    const manager = new RecordingManager({ defaultOutputDir: tempDir(), now: () => 0 });
    const session = manager.start({
      prefs: {
        ...DEFAULT_RECORDING_PREFS,
        enabled: true,
        includeInput: false,
        includeOutput: false,
        includeMixed: true,
      },
      sessionType: 'test',
      sourceLang: 'en',
      targetLang: 'pt',
      directions: ['B'],
    });
    expect(session).toBeDefined();
    session!.recordInput('B', pcmBase64([1000]));
    session!.recordOutput('B', pcmBase64([3000]));
    await session!.stop();

    expect(() => readFileSync(join(session!.outputDir, 'direction-b-input.wav'))).toThrow();
    expect(() => readFileSync(join(session!.outputDir, 'direction-b-output.wav'))).toThrow();
    expect(dataSize(join(session!.outputDir, 'direction-b-mixed.wav'))).toBe(2);
  });

  it('mixes PCM16 using the configured input percentage', () => {
    const input = Buffer.alloc(2);
    const output = Buffer.alloc(2);
    input.writeInt16LE(1000, 0);
    output.writeInt16LE(3000, 0);
    const mixed = mixPcm16(input, output, 25);
    expect(mixed.readInt16LE(0)).toBe(2500);
  });

  it('returns undefined when recording is disabled', () => {
    const manager = new RecordingManager({
      defaultOutputDir: tempDir(),
      onWarning: vi.fn(),
      now: () => 0,
    });
    const session = manager.start({
      prefs: DEFAULT_RECORDING_PREFS,
      sessionType: 'live',
      sourceLang: 'pt',
      targetLang: 'en',
    });
    expect(session).toBeUndefined();
  });

  it('pads delayed output with silence so tracks share the same session start', async () => {
    let now = 0;
    const manager = new RecordingManager({ defaultOutputDir: tempDir(), now: () => now });
    const session = manager.start({
      prefs: {
        ...DEFAULT_RECORDING_PREFS,
        enabled: true,
        includeMixed: true,
      },
      sessionType: 'test',
      sourceLang: 'pt',
      targetLang: 'en',
      directions: ['A'],
    });
    expect(session).toBeDefined();
    session!.recordInput('A', pcmBase64([1000]));
    now = 1000;
    session!.recordOutput('A', pcmBase64([3000]));
    await session!.stop();

    const output = readFileSync(join(session!.outputDir, 'direction-a-output.wav'));
    expect(output.readInt16LE(44)).toBe(0);
    expect(output.readInt16LE(44 + 24000 * 2)).toBe(3000);
    expect(dataSize(join(session!.outputDir, 'direction-a-input.wav'))).toBe(
      dataSize(join(session!.outputDir, 'direction-a-output.wav')),
    );
  });
});
