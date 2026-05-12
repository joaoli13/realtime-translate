import { describe, it, expect } from 'vitest';
import { bothCablesPresent, hasVirtualRoutingReady } from '@renderer/views/setup/shared/cables';
import type { DeviceInventory } from '@shared/types';

const dummy = { deviceId: 'x', label: 'X', kind: 'audioinput' as const };
const dummyOut = { deviceId: 'y', label: 'Y', kind: 'audiooutput' as const };

const baseInv: DeviceInventory = { inputs: [], outputs: [] };

describe('bothCablesPresent', () => {
  it('returns true when both cables have both sides', () => {
    expect(bothCablesPresent({
      ...baseInv,
      cableA: { playback: dummyOut, recording: dummy },
      cableB: { playback: dummyOut, recording: dummy },
    })).toBe(true);
  });

  it('returns false when only cable A is present', () => {
    expect(bothCablesPresent({
      ...baseInv,
      cableA: { playback: dummyOut, recording: dummy },
    })).toBe(false);
  });

  it('returns false when only cable B is present', () => {
    expect(bothCablesPresent({
      ...baseInv,
      cableB: { playback: dummyOut, recording: dummy },
    })).toBe(false);
  });

  it('returns false when both cables exist but one side is missing', () => {
    expect(bothCablesPresent({
      ...baseInv,
      cableA: { playback: dummyOut },
      cableB: { playback: dummyOut, recording: dummy },
    })).toBe(false);
  });

  it('returns false on empty inventory', () => {
    expect(bothCablesPresent(baseInv)).toBe(false);
  });

  it('accepts macOS manual virtual candidates when two inputs and outputs exist', () => {
    expect(hasVirtualRoutingReady({
      ...baseInv,
      platform: 'darwin',
      virtualInputs: [
        { ...dummy, deviceId: 'in-1' },
        { ...dummy, deviceId: 'in-2' },
      ],
      virtualOutputs: [
        { ...dummyOut, deviceId: 'out-1' },
        { ...dummyOut, deviceId: 'out-2' },
      ],
    })).toBe(true);
  });

  it('does not accept macOS manual candidates with only one side each', () => {
    expect(hasVirtualRoutingReady({
      ...baseInv,
      platform: 'darwin',
      virtualInputs: [{ ...dummy, deviceId: 'in-1' }],
      virtualOutputs: [{ ...dummyOut, deviceId: 'out-1' }],
    })).toBe(false);
  });
});
