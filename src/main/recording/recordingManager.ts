import { createWriteStream, mkdirSync, promises as fsp, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Direction, RecordingPrefs } from '../../shared/types';
import { normalizeRecordingPrefs, recordingHasAnyArtifact } from '../../shared/types';
import type { LanguageCode } from '../../shared/languages';

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const PCM_BYTES_PER_SAMPLE = 2;
const MAX_INT16 = 0x7fff;
const MIN_INT16 = -0x8000;

export interface RecordingManagerConfig {
  defaultOutputDir: string;
  onWarning?: (message: string, session?: RecordingSession) => void;
  now?: () => number;
}

export interface RecordingStartArgs {
  prefs: RecordingPrefs;
  sessionType: 'live' | 'test';
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  directions?: Direction[];
}

export interface RecordingMetadata {
  sessionId: string;
  sessionType: 'live' | 'test';
  startedAt: string;
  endedAt?: string;
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  sampleRate: number;
  channels: number;
  format: 'wav-pcm16';
  mixedInputPercent: number;
  mixedOutputPercent: number;
  directions: Direction[];
  files: Array<{
    direction: Direction;
    kind: 'input' | 'output' | 'mixed';
    fileName: string;
    sampleRate: number;
    bytes: number;
  }>;
}

interface RawTrack {
  path: string;
  stream: NodeJS.WritableStream;
  bytes: number;
  failed: boolean;
}

interface DirectionTracks {
  input?: RawTrack;
  output?: RawTrack;
}

export class RecordingSession {
  readonly prefs: RecordingPrefs;
  readonly sessionId: string;
  readonly outputDir: string;
  readonly metadata: RecordingMetadata;
  private readonly tracks = new Map<Direction, DirectionTracks>();
  private readonly startedAtMs: number;
  private stopped = false;

  constructor(
    private readonly manager: RecordingManager,
    args: RecordingStartArgs,
    outputDir: string,
  ) {
    this.prefs = normalizeRecordingPrefs(args.prefs);
    this.startedAtMs = this.manager.now();
    this.sessionId = `${args.sessionType}-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    this.outputDir = join(outputDir, this.sessionId);
    mkdirSync(this.outputDir, { recursive: true });
    const directions = args.directions ?? enabledDirections(this.prefs);
    this.metadata = {
      sessionId: this.sessionId,
      sessionType: args.sessionType,
      startedAt: new Date().toISOString(),
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      format: 'wav-pcm16',
      mixedInputPercent: this.prefs.mixedInputPercent,
      mixedOutputPercent: 100 - this.prefs.mixedInputPercent,
      directions,
      files: [],
    };

    for (const direction of directions) {
      const tracks: DirectionTracks = {};
      if (this.needsInputSource()) tracks.input = this.openRawTrack(direction, 'input');
      if (this.needsOutputSource()) tracks.output = this.openRawTrack(direction, 'output');
      this.tracks.set(direction, tracks);
    }
  }

  recordInput(direction: Direction, base64: string): void {
    this.write(direction, 'input', base64);
  }

  recordOutput(direction: Direction, base64: string): void {
    this.write(direction, 'output', base64);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const finalBytes = Math.max(
      bytesForElapsedMs(this.manager.now() - this.startedAtMs),
      ...Array.from(this.tracks.values()).flatMap((tracks) => [
        tracks.input?.bytes ?? 0,
        tracks.output?.bytes ?? 0,
      ]),
    );
    for (const tracks of this.tracks.values()) {
      this.padTo(tracks.input, finalBytes);
      this.padTo(tracks.output, finalBytes);
    }
    for (const tracks of this.tracks.values()) {
      await Promise.all([
        tracks.input ? closeTrack(tracks.input) : undefined,
        tracks.output ? closeTrack(tracks.output) : undefined,
      ]);
    }

    for (const [direction, tracks] of this.tracks) {
      if (this.prefs.includeInput && tracks.input && !tracks.input.failed) {
        const fileName = fileNameFor(direction, 'input');
        await writeWavFromRaw(tracks.input.path, join(this.outputDir, fileName));
        this.addMetadataFile(direction, 'input', fileName, tracks.input.bytes);
      }
      if (this.prefs.includeOutput && tracks.output && !tracks.output.failed) {
        const fileName = fileNameFor(direction, 'output');
        await writeWavFromRaw(tracks.output.path, join(this.outputDir, fileName));
        this.addMetadataFile(direction, 'output', fileName, tracks.output.bytes);
      }
      if (this.prefs.includeMixed && tracks.input && tracks.output && !tracks.input.failed && !tracks.output.failed) {
        try {
          const fileName = fileNameFor(direction, 'mixed');
          const bytes = await writeMixedWav({
            inputRawPath: tracks.input.path,
            outputRawPath: tracks.output.path,
            outputWavPath: join(this.outputDir, fileName),
            inputPercent: this.prefs.mixedInputPercent,
          });
          this.addMetadataFile(direction, 'mixed', fileName, bytes);
        } catch (err) {
          this.manager.warn(
            `Could not create mixed recording for direction ${direction}: ${messageOf(err)}`,
            this,
          );
        }
      }
      removeRaw(tracks.input);
      removeRaw(tracks.output);
    }

    this.metadata.endedAt = new Date().toISOString();
    await fsp.writeFile(
      join(this.outputDir, 'metadata.json'),
      JSON.stringify(this.metadata, null, 2),
      'utf8',
    );
  }

  private needsInputSource(): boolean {
    return this.prefs.includeInput || this.prefs.includeMixed;
  }

  private needsOutputSource(): boolean {
    return this.prefs.includeOutput || this.prefs.includeMixed;
  }

  private openRawTrack(direction: Direction, kind: 'input' | 'output'): RawTrack {
    const path = join(this.outputDir, `.${direction.toLowerCase()}-${kind}.pcm`);
    const stream = createWriteStream(path);
    const track: RawTrack = { path, stream, bytes: 0, failed: false };
    stream.on('error', (err) => {
      track.failed = true;
      this.manager.warn(`Recording ${direction} ${kind} failed: ${err.message}`, this);
    });
    return track;
  }

  private write(direction: Direction, kind: 'input' | 'output', base64: string): void {
    if (this.stopped) return;
    const track = this.tracks.get(direction)?.[kind];
    if (!track || track.failed) return;
    try {
      const buf = Buffer.from(base64, 'base64');
      this.padTo(track, bytesForElapsedMs(this.manager.now() - this.startedAtMs));
      track.bytes += buf.byteLength;
      track.stream.write(buf);
    } catch (err) {
      track.failed = true;
      this.manager.warn(`Recording ${direction} ${kind} failed: ${messageOf(err)}`, this);
    }
  }

  private padTo(track: RawTrack | undefined, targetBytes: number): void {
    if (!track || track.failed || track.bytes >= targetBytes) return;
    const paddingBytes = targetBytes - track.bytes;
    const alignedPadding = paddingBytes - (paddingBytes % PCM_BYTES_PER_SAMPLE);
    if (alignedPadding <= 0) return;
    track.bytes += alignedPadding;
    track.stream.write(Buffer.alloc(alignedPadding));
  }

  private addMetadataFile(
    direction: Direction,
    kind: 'input' | 'output' | 'mixed',
    fileName: string,
    bytes: number,
  ): void {
    this.metadata.files.push({
      direction,
      kind,
      fileName,
      sampleRate: SAMPLE_RATE,
      bytes,
    });
  }
}

export class RecordingManager {
  constructor(private readonly cfg: RecordingManagerConfig) {}

  now(): number {
    return this.cfg.now?.() ?? Date.now();
  }

  start(args: RecordingStartArgs): RecordingSession | undefined {
    const prefs = normalizeRecordingPrefs(args.prefs);
    if (!prefs.enabled || !recordingHasAnyArtifact(prefs)) return undefined;
    const directions = args.directions ?? enabledDirections(prefs);
    if (directions.length === 0) return undefined;
    const outputDir = prefs.outputDir || this.cfg.defaultOutputDir;
    mkdirSync(outputDir, { recursive: true });
    return new RecordingSession(this, { ...args, prefs, directions }, outputDir);
  }

  warn(message: string, session?: RecordingSession): void {
    this.cfg.onWarning?.(message, session);
  }
}

function bytesForElapsedMs(elapsedMs: number): number {
  const samples = Math.max(0, Math.round((elapsedMs / 1000) * SAMPLE_RATE));
  return samples * PCM_BYTES_PER_SAMPLE;
}

export function enabledDirections(prefs: RecordingPrefs): Direction[] {
  const directions: Direction[] = [];
  if (prefs.directionA) directions.push('A');
  if (prefs.directionB) directions.push('B');
  return directions;
}

export function mixPcm16(input: Buffer, output: Buffer, inputPercent: number): Buffer {
  const inputGain = Math.min(100, Math.max(0, inputPercent)) / 100;
  const outputGain = 1 - inputGain;
  const byteLength = Math.max(input.byteLength, output.byteLength);
  const alignedLength = byteLength % PCM_BYTES_PER_SAMPLE === 0 ? byteLength : byteLength + 1;
  const mixed = Buffer.alloc(alignedLength);
  for (let offset = 0; offset < alignedLength; offset += PCM_BYTES_PER_SAMPLE) {
    const a = offset + 1 < input.byteLength ? input.readInt16LE(offset) : 0;
    const b = offset + 1 < output.byteLength ? output.readInt16LE(offset) : 0;
    const value = Math.round(a * inputGain + b * outputGain);
    mixed.writeInt16LE(Math.min(MAX_INT16, Math.max(MIN_INT16, value)), offset);
  }
  return mixed;
}

async function writeMixedWav(args: {
  inputRawPath: string;
  outputRawPath: string;
  outputWavPath: string;
  inputPercent: number;
}): Promise<number> {
  const [input, output] = await Promise.all([
    fsp.readFile(args.inputRawPath),
    fsp.readFile(args.outputRawPath),
  ]);
  const mixed = mixPcm16(input, output, args.inputPercent);
  await writeWav(args.outputWavPath, mixed);
  return mixed.byteLength;
}

async function writeWavFromRaw(rawPath: string, wavPath: string): Promise<void> {
  const pcm = await fsp.readFile(rawPath);
  await writeWav(wavPath, pcm);
}

async function writeWav(path: string, pcm: Buffer): Promise<void> {
  const header = createWavHeader(pcm.byteLength);
  await fsp.writeFile(path, Buffer.concat([header, pcm]));
}

function createWavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function fileNameFor(direction: Direction, kind: 'input' | 'output' | 'mixed'): string {
  return `direction-${direction.toLowerCase()}-${kind}.wav`;
}

function closeTrack(track: RawTrack): Promise<void> {
  return new Promise((resolve) => {
    track.stream.end(resolve);
  });
}

function removeRaw(track: RawTrack | undefined): void {
  if (!track) return;
  try {
    rmSync(track.path, { force: true });
  } catch {
    // Best effort cleanup only.
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
