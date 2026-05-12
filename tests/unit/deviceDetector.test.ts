import { describe, it, expect } from 'vitest';
import { detectVirtualCables, type DeviceInfo } from '@main/audio/deviceDetector';

const dev = (kind: 'audioinput' | 'audiooutput', label: string, deviceId = label): DeviceInfo => ({
  kind,
  label,
  deviceId,
});

describe('detectVirtualCables', () => {
  it('finds VB-CABLE A input/output', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'CABLE-A Input (VB-Audio Cable A)'),
      dev('audioinput', 'CABLE-A Output (VB-Audio Cable A)'),
      dev('audiooutput', 'Speakers (Realtek)'),
      dev('audioinput', 'Mic (USB)'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA?.playback?.label).toContain('CABLE-A Input');
    expect(result.cableA?.recording?.label).toContain('CABLE-A Output');
  });

  it('finds VB-CABLE B input/output', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'CABLE-B Input (VB-Audio Cable B)'),
      dev('audioinput', 'CABLE-B Output (VB-Audio Cable B)'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableB?.playback?.label).toContain('CABLE-B Input');
    expect(result.cableB?.recording?.label).toContain('CABLE-B Output');
  });

  it('handles alternate label formats', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'VB-Audio Cable A Input'),
      dev('audioinput', 'VB-Audio Cable A Output'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA?.playback).toBeDefined();
    expect(result.cableA?.recording).toBeDefined();
  });

  it('returns undefined for missing cables', () => {
    const devices: DeviceInfo[] = [
      dev('audioinput', 'Mic'),
      dev('audiooutput', 'Speakers'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA).toBeUndefined();
    expect(result.cableB).toBeUndefined();
  });

  it('listRealDevices excludes virtual cables', () => {
    const devices: DeviceInfo[] = [
      dev('audioinput', 'Mic (USB)'),
      dev('audioinput', 'CABLE-A Output'),
      dev('audiooutput', 'Speakers'),
      dev('audiooutput', 'CABLE-B Input'),
    ];
    const real = detectVirtualCables(devices).realDevices;
    expect(real.inputs.map((d) => d.label)).toEqual(['Mic (USB)']);
    expect(real.outputs.map((d) => d.label)).toEqual(['Speakers']);
  });

  it('falls back to basic VB-CABLE (no A/B suffix) for cableA', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'CABLE Input (VB-Audio Virtual Cable)'),
      dev('audioinput', 'CABLE Output (VB-Audio Virtual Cable)'),
      dev('audiooutput', 'Speakers (Realtek)'),
      dev('audioinput', 'Mic (USB)'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA?.playback?.label).toBe('CABLE Input (VB-Audio Virtual Cable)');
    expect(result.cableA?.recording?.label).toBe('CABLE Output (VB-Audio Virtual Cable)');
    expect(result.cableB).toBeUndefined();
    // Basic CABLE should also be filtered out of real devices.
    expect(result.realDevices.outputs.map((d) => d.label)).toEqual(['Speakers (Realtek)']);
    expect(result.realDevices.inputs.map((d) => d.label)).toEqual(['Mic (USB)']);
  });

  it('prefers explicit CABLE-A over basic CABLE when both present', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'CABLE-A Input (VB-Audio Cable A)'),
      dev('audioinput', 'CABLE-A Output (VB-Audio Cable A)'),
      dev('audiooutput', 'CABLE Input (VB-Audio Virtual Cable)'),
      dev('audioinput', 'CABLE Output (VB-Audio Virtual Cable)'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA?.playback?.label).toBe('CABLE-A Input (VB-Audio Cable A)');
    expect(result.cableA?.recording?.label).toBe('CABLE-A Output (VB-Audio Cable A)');
  });

  it('detects two complete BlackHole route pairs on macOS', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'BlackHole 2ch'),
      dev('audioinput', 'BlackHole 2ch'),
      dev('audiooutput', 'BlackHole 16ch'),
      dev('audioinput', 'BlackHole 16ch'),
      dev('audioinput', 'MacBook Pro Microphone'),
      dev('audiooutput', 'MacBook Pro Speakers'),
    ];
    const result = detectVirtualCables(devices, 'darwin');
    expect(result.platform).toBe('darwin');
    expect(result.cableA?.provider).toBe('blackhole');
    expect(result.cableA?.playback?.label).toBe('BlackHole 2ch');
    expect(result.cableA?.recording?.label).toBe('BlackHole 2ch');
    expect(result.cableB?.provider).toBe('blackhole');
    expect(result.cableB?.playback?.label).toBe('BlackHole 16ch');
    expect(result.realDevices.inputs.map((d) => d.label)).toEqual(['MacBook Pro Microphone']);
    expect(result.realDevices.outputs.map((d) => d.label)).toEqual(['MacBook Pro Speakers']);
  });

  it('detects Loopback route pairs on macOS', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'Loopback A'),
      dev('audioinput', 'Loopback A'),
      dev('audiooutput', 'Loopback B'),
      dev('audioinput', 'Loopback B'),
    ];
    const result = detectVirtualCables(devices, 'darwin');
    expect(result.cableA?.provider).toBe('loopback');
    expect(result.cableB?.provider).toBe('loopback');
  });

  it('exposes ambiguous macOS virtual candidates for manual selection', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'BlackHole Output Route 1'),
      dev('audiooutput', 'BlackHole Output Route 2'),
      dev('audioinput', 'BlackHole Input Route 1'),
      dev('audioinput', 'BlackHole Input Route 2'),
    ];
    const result = detectVirtualCables(devices, 'darwin');
    expect(result.cableA).toBeUndefined();
    expect(result.cableB).toBeUndefined();
    expect(result.virtualDevices.outputs).toHaveLength(2);
    expect(result.virtualDevices.inputs).toHaveLength(2);
  });
});
