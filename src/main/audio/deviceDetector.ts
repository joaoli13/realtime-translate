import type { AudioPlatform, VirtualAudioProvider } from '../../shared/types';

export interface DeviceInfo {
  kind: 'audioinput' | 'audiooutput';
  label: string;
  deviceId: string;
}

export interface CablePair {
  label?: string;
  provider?: VirtualAudioProvider;
  playback?: DeviceInfo;
  recording?: DeviceInfo;
}

export interface DetectionResult {
  platform: AudioPlatform;
  cableA?: CablePair;
  cableB?: CablePair;
  virtualDevices: { inputs: DeviceInfo[]; outputs: DeviceInfo[] };
  realDevices: { inputs: DeviceInfo[]; outputs: DeviceInfo[] };
}

const A_PLAYBACK = /CABLE[-\s]?A.*Input|VB-?Audio.*Cable[-\s]?A.*Input/i;
const A_RECORDING = /CABLE[-\s]?A.*Output|VB-?Audio.*Cable[-\s]?A.*Output/i;
const B_PLAYBACK = /CABLE[-\s]?B.*Input|VB-?Audio.*Cable[-\s]?B.*Input/i;
const B_RECORDING = /CABLE[-\s]?B.*Output|VB-?Audio.*Cable[-\s]?B.*Output/i;
// Basic VB-CABLE (single cable, no A/B suffix). Fills cableA slot when A+B not detected.
const PLAIN_PLAYBACK = /^CABLE\s+Input\s*\(VB-?Audio/i;
const PLAIN_RECORDING = /^CABLE\s+Output\s*\(VB-?Audio/i;
const ANY_VIRTUAL = /CABLE[-\s]?[AB]|VB-?Audio.*Cable|^CABLE\s+(Input|Output)/i;
const MAC_VIRTUAL = /blackhole|loopback|soundflower/i;

function normalizePlatform(platform: NodeJS.Platform | string): AudioPlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform;
  return 'unknown';
}

export function detectVirtualCables(
  devices: DeviceInfo[],
  platform: NodeJS.Platform | string = 'win32',
): DetectionResult {
  const normalized = normalizePlatform(platform);
  if (normalized === 'darwin') return detectMacVirtualRoutes(devices, normalized);
  return detectWindowsVirtualCables(devices, normalized);
}

function detectWindowsVirtualCables(
  devices: DeviceInfo[],
  platform: AudioPlatform,
): DetectionResult {
  const findOne = (kind: 'audioinput' | 'audiooutput', re: RegExp): DeviceInfo | undefined =>
    devices.find((d) => d.kind === kind && re.test(d.label));

  let cableAPlayback = findOne('audiooutput', A_PLAYBACK);
  let cableARecording = findOne('audioinput', A_RECORDING);
  const cableBPlayback = findOne('audiooutput', B_PLAYBACK);
  const cableBRecording = findOne('audioinput', B_RECORDING);

  // Fallback: if neither CABLE-A nor CABLE-B variants found, look for the basic
  // single-cable VB-CABLE and use it as cableA. M1 (unidirectional) needs only one cable.
  if (!cableAPlayback && !cableARecording) {
    cableAPlayback = findOne('audiooutput', PLAIN_PLAYBACK);
    cableARecording = findOne('audioinput', PLAIN_RECORDING);
  }

  const buildPair = (
    label: string,
    playback: DeviceInfo | undefined,
    recording: DeviceInfo | undefined,
  ): CablePair | undefined => {
    if (!playback && !recording) return undefined;
    return {
      label,
      provider: 'vb-cable',
      ...(playback ? { playback } : {}),
      ...(recording ? { recording } : {}),
    };
  };

  const cableA = buildPair('CABLE-A', cableAPlayback, cableARecording);
  const cableB = buildPair('CABLE-B', cableBPlayback, cableBRecording);

  const virtualInputs = devices.filter((d) => d.kind === 'audioinput' && ANY_VIRTUAL.test(d.label));
  const virtualOutputs = devices.filter((d) => d.kind === 'audiooutput' && ANY_VIRTUAL.test(d.label));
  const inputs = devices.filter((d) => d.kind === 'audioinput' && !ANY_VIRTUAL.test(d.label));
  const outputs = devices.filter((d) => d.kind === 'audiooutput' && !ANY_VIRTUAL.test(d.label));

  const result: DetectionResult = {
    platform,
    virtualDevices: { inputs: virtualInputs, outputs: virtualOutputs },
    realDevices: { inputs, outputs },
  };
  if (cableA) result.cableA = cableA;
  if (cableB) result.cableB = cableB;
  return result;
}

function detectMacVirtualRoutes(devices: DeviceInfo[], platform: AudioPlatform): DetectionResult {
  const providerFor = (label: string): VirtualAudioProvider => {
    if (/blackhole/i.test(label)) return 'blackhole';
    if (/loopback/i.test(label)) return 'loopback';
    if (/soundflower/i.test(label)) return 'soundflower';
    return 'manual';
  };

  const virtualInputs = devices.filter((d) => d.kind === 'audioinput' && MAC_VIRTUAL.test(d.label));
  const virtualOutputs = devices.filter((d) => d.kind === 'audiooutput' && MAC_VIRTUAL.test(d.label));
  const realInputs = devices.filter((d) => d.kind === 'audioinput' && !MAC_VIRTUAL.test(d.label));
  const realOutputs = devices.filter((d) => d.kind === 'audiooutput' && !MAC_VIRTUAL.test(d.label));

  const byLabel = new Map<string, { label: string; inputs: DeviceInfo[]; outputs: DeviceInfo[] }>();
  for (const d of [...virtualInputs, ...virtualOutputs]) {
    const key = normalizeMacRouteLabel(d.label);
    const group = byLabel.get(key) ?? { label: d.label, inputs: [], outputs: [] };
    if (d.kind === 'audioinput') group.inputs.push(d);
    else group.outputs.push(d);
    byLabel.set(key, group);
  }

  const completePairs = [...byLabel.values()]
    .filter((g) => g.inputs.length > 0 && g.outputs.length > 0)
    .sort((a, b) => macRouteRank(a.label) - macRouteRank(b.label) || a.label.localeCompare(b.label))
    .map((g): CablePair => ({
      label: g.label,
      provider: providerFor(g.label),
      recording: g.inputs[0]!,
      playback: g.outputs[0]!,
    }));

  const result: DetectionResult = {
    platform,
    virtualDevices: { inputs: virtualInputs, outputs: virtualOutputs },
    realDevices: { inputs: realInputs, outputs: realOutputs },
  };
  if (completePairs[0]) result.cableA = completePairs[0];
  if (completePairs[1]) result.cableB = completePairs[1];
  return result;
}

function normalizeMacRouteLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s*\((input|output)\)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function macRouteRank(label: string): number {
  if (/\b(a|1)\b|to\s*meet|meet\s*mic|blackhole\s*2ch/i.test(label)) return 0;
  if (/\b(b|2)\b|from\s*meet|meet\s*speaker|blackhole\s*16ch/i.test(label)) return 1;
  return 2;
}
