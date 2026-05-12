import { useEffect, useState, type JSX } from 'react';
import { useT } from '../../../../shared/i18n/I18nProvider';
import { ConfirmModal } from '../../../components/ConfirmModal';
import { rt } from '../../../ipc/client';
import { useStore } from '../../../state/store';
import { navigate } from '../shared/useHashRoute';
import type { WaveformSample } from '../../../../shared/types';

type TestStatus = 'idle' | 'running' | 'passed' | 'failed';
interface Result { status: TestStatus; reason?: string }
type TestRunState = 'idle' | 'sending' | 'live' | 'replay';
const MAX_WAVEFORM_SAMPLES = 90;

/**
 * Loads a bundled test WAV (24kHz mono PCM16) and returns 50ms PCM-only chunks
 * encoded as base64 — ready to feed straight to OpenAI's
 * `session.input_audio_buffer.append`.
 *
 * CRITICAL: relative path `./test/...`, not `/test/...`. The renderer loads
 * setup-view.html via `file://` in production where a leading `/` resolves to
 * the drive root, not the renderer's outDir. Same fix as Task 10's PNGs.
 */
// 50ms of PCM16 silence at 24kHz mono = 1200 samples × 2 bytes = 2400 bytes of zero.
// Used to pad the end of the test WAV so OpenAI's server VAD detects end-of-speech
// and finalizes the translation; without this the model can hang waiting for more
// input until the WS times out.
const SILENCE_CHUNK_BASE64 = (() => {
  let bin = '';
  for (let i = 0; i < 2400; i++) bin += '\0';
  return btoa(bin);
})();
const SILENCE_PAD_CHUNKS = 10; // 10 × 50ms = 500ms trailing silence

async function loadTestWavAsPcmChunks(filename: string): Promise<string[]> {
  const url = `./test/${filename}`;
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  // Skip 44-byte WAV header, read raw PCM16 little-endian.
  const pcmBytes = new Uint8Array(arrayBuffer.slice(44));
  const samplesPerChunk = (24000 * 50) / 1000; // 50ms chunks → 1200 samples → 2400 bytes
  const chunkBytes = samplesPerChunk * 2;
  const chunks: string[] = [];
  for (let i = 0; i < pcmBytes.byteLength; i += chunkBytes) {
    const slice = pcmBytes.slice(i, Math.min(i + chunkBytes, pcmBytes.byteLength));
    let bin = '';
    for (let j = 0; j < slice.length; j++) {
      const byte = slice[j] ?? 0;
      bin += String.fromCharCode(byte);
    }
    chunks.push(btoa(bin));
  }
  return chunks;
}

export function Step6TestTranslation({ mode }: { mode?: 'edit' | undefined }): JSX.Element {
  const t = useT();
  const { sourceLang, targetLang, selectedMic, selectedToMeet, selectedHeadset, recordingPrefs } = useStore();
  const [resA, setResA] = useState<Result>({ status: 'idle' });
  const [resB, setResB] = useState<Result>({ status: 'idle' });
  const [skipped, setSkipped] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [testRecordingEnabled, setTestRecordingEnabled] = useState(recordingPrefs.enabled);
  const [waveform, setWaveform] = useState<WaveformSample[]>([]);
  const [latestWaveform, setLatestWaveform] = useState<WaveformSample[]>([]);
  const [runState, setRunState] = useState<TestRunState>('idle');
  const [liveMicRunning, setLiveMicRunning] = useState(false);

  useEffect(() => {
    const off = rt.onTestLivePcm('A', ({ kind, base64 }) => {
      const sample = kind === 'input'
        ? { input: pcmRms(base64), output: 0 }
        : { input: 0, output: pcmRms(base64) };
      setWaveform((prev) => [...prev.slice(-(MAX_WAVEFORM_SAMPLES - 1)), sample]);
      setRunState('live');
    });
    return off;
  }, []);

  const appendWaveform = (sample: WaveformSample): void => {
    setWaveform((prev) => [...prev.slice(-(MAX_WAVEFORM_SAMPLES - 1)), sample]);
  };

  const resetWaveform = (): void => {
    setWaveform([]);
    setRunState('sending');
  };

  const finishWaveform = (): void => {
    setWaveform((current) => {
      setLatestWaveform(current);
      return current;
    });
    setRunState('idle');
  };

  const runA = async (): Promise<void> => {
    setResA({ status: 'running' });
    // 'No selectedToMeet device' stays English: "shouldn't happen" — wizard gates step 4
    // on all 4 devices selected, so this branch only fires if state was somehow cleared.
    if (!selectedToMeet) {
      setResA({ status: 'failed', reason: 'No selectedToMeet device' });
      return;
    }
    let offTestAudio: (() => void) | undefined;
    let started = false;
    let audioReceived = false;
    try {
      const chunks = await loadTestWavAsPcmChunks('test-pt.wav');
      resetWaveform();
      await rt.testSessionStart({
        direction: 'A',
        sourceLang: 'pt',
        targetLang: 'en',
        recordingEnabled: testRecordingEnabled,
      });
      started = true;

      offTestAudio = rt.onTestAudio('A', (b64) => {
        audioReceived = true;
        setRunState('live');
        appendWaveform({ input: 0, output: pcmRms(b64) });
        rt.testRoutePlayback({ direction: 'A', deviceId: selectedToMeet, base64: b64 })
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error('[step6] testRoutePlayback A failed', err);
          });
      });

      for (const chunk of chunks) {
        appendWaveform({ input: pcmRms(chunk), output: 0 });
        await rt.testSessionInject({ direction: 'A', base64: chunk });
        await new Promise((r) => setTimeout(r, 50));
      }
      // Trailing silence padding so server VAD detects end-of-input.
      for (let i = 0; i < SILENCE_PAD_CHUNKS; i++) {
        appendWaveform({ input: 0, output: 0 });
        await rt.testSessionInject({ direction: 'A', base64: SILENCE_CHUNK_BASE64 });
        await new Promise((r) => setTimeout(r, 50));
      }
      await rt.testSessionInputDone({ direction: 'A' });

      const inv = await rt.listDevices();
      const cableARecording = inv.cableA?.recording?.deviceId;
      if (!cableARecording) throw new Error(t('setup.test.cableANotDetected'));

      const result = await rt.loopbackStart({
        deviceId: cableARecording,
        thresholdRms: 0.01,
        timeoutMs: 20000,
      });

      if (result.detected) setResA({ status: 'passed' });
      else if (!audioReceived) setResA({ status: 'failed', reason: t('setup.test.openaiNoAudio') });
      else setResA({ status: 'failed', reason: t('setup.test.noLoopbackDespiteAudio') });
    } catch (e) {
      setResA({ status: 'failed', reason: (e as Error).message });
    } finally {
      // Always release the listener and stop the session — otherwise rapid retry
      // stacks listeners (every chunk gets routed twice+) and orphans the WS.
      offTestAudio?.();
      if (started) {
        await rt.testSessionStop({ direction: 'A' }).catch(() => undefined);
      }
      finishWaveform();
    }
  };

  const runB = async (): Promise<void> => {
    setResB({ status: 'running' });
    if (!selectedHeadset) {
      setResB({ status: 'failed', reason: 'No selectedHeadset device' });
      return;
    }
    let offTestAudio: (() => void) | undefined;
    let started = false;
    let audioReceived = false;
    try {
      const chunks = await loadTestWavAsPcmChunks('test-en.wav');
      resetWaveform();
      await rt.testSessionStart({
        direction: 'B',
        sourceLang: 'en',
        targetLang: 'pt',
        recordingEnabled: testRecordingEnabled,
      });
      started = true;

      offTestAudio = rt.onTestAudio('B', (b64) => {
        audioReceived = true;
        setRunState('live');
        appendWaveform({ input: 0, output: pcmRms(b64) });
        rt.testRoutePlayback({ direction: 'B', deviceId: selectedHeadset, base64: b64 })
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error('[step6] testRoutePlayback B failed', err);
          });
      });

      for (const chunk of chunks) {
        appendWaveform({ input: pcmRms(chunk), output: 0 });
        await rt.testSessionInject({ direction: 'B', base64: chunk });
        await new Promise((r) => setTimeout(r, 50));
      }
      // Trailing silence padding so server VAD detects end-of-input.
      for (let i = 0; i < SILENCE_PAD_CHUNKS; i++) {
        appendWaveform({ input: 0, output: 0 });
        await rt.testSessionInject({ direction: 'B', base64: SILENCE_CHUNK_BASE64 });
        await new Promise((r) => setTimeout(r, 50));
      }
      await rt.testSessionInputDone({ direction: 'B' });

      // Wait ~5s for translation to play.
      await new Promise((r) => setTimeout(r, 5000));

      // If OpenAI never returned audio, no point asking the user — short-circuit
      // with the more accurate failure reason.
      if (!audioReceived) {
        setResB({ status: 'failed', reason: t('setup.test.openaiNoAudio') });
      } else {
        // Open the modal — runB returns here; user clicks Cancel/Confirm in the
        // modal callbacks below to finalize.
        setConfirmOpen(true);
      }
    } catch (e) {
      setResB({ status: 'failed', reason: (e as Error).message });
    } finally {
      offTestAudio?.();
      if (started) {
        await rt.testSessionStop({ direction: 'B' }).catch(() => undefined);
      }
      finishWaveform();
    }
  };

  const replayWaveform = (): void => {
    if (latestWaveform.length === 0) return;
    setWaveform([]);
    setRunState('replay');
    latestWaveform.forEach((sample, index) => {
      window.setTimeout(() => {
        setWaveform((prev) => [...prev.slice(-(MAX_WAVEFORM_SAMPLES - 1)), sample]);
        if (index === latestWaveform.length - 1) setRunState('idle');
      }, index * 35);
    });
  };

  const startLiveMic = async (): Promise<void> => {
    if (!selectedMic || !selectedHeadset) {
      setResA({ status: 'failed', reason: t('setup.test.liveMissingDevices') });
      return;
    }
    setTestRecordingEnabled(true);
    resetWaveform();
    setResA({ status: 'running' });
    await rt.testLiveStart({
      direction: 'A',
      sourceLang,
      targetLang,
      inputDeviceId: selectedMic,
      outputDeviceId: selectedHeadset,
      recordingEnabled: true,
    });
    setLiveMicRunning(true);
    setRunState('live');
  };

  const stopLiveMic = async (): Promise<void> => {
    await rt.testLiveStop({ direction: 'A' });
    setLiveMicRunning(false);
    setResA({ status: 'passed' });
    finishWaveform();
  };

  const onConfirmHeard = (): void => {
    setResB({ status: 'passed' });
    setConfirmOpen(false);
  };
  const onCancelHeard = (): void => {
    setResB({ status: 'failed', reason: t('setup.test.userNoAudio') });
    setConfirmOpen(false);
  };

  const back = (): void => {
    navigate(mode === 'edit' ? { kind: 'review' } : { kind: 'wizard', step: 5 });
  };

  const concluir = async (): Promise<void> => {
    if (mode === 'edit') {
      navigate({ kind: 'review' });
      return;
    }
    await rt.markSetupComplete();
  };

  const allPassed = resA.status === 'passed' && resB.status === 'passed';
  const canFinish = allPassed || skipped;

  return (
    <>
      <div className="setup-step-meta">{t('setup.stepLabel', { n: 6, total: 6 })} — {t('setup.test.label')}</div>
      <h1 className="setup-heading">{t('setup.test.heading')}</h1>
      <p className="setup-sub">{t('setup.test.sub')}</p>

      <div className="test-panel">
        <div className="test-panel__top">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={latestWaveform.length === 0 || runState === 'replay'}
            onClick={replayWaveform}
          >
            {t('setup.test.replay')}
          </button>
          <div className="test-panel__status">
            <span>{runState === 'sending' ? t('setup.test.sendingAudio') : ''}</span>
            <span>{runState === 'live' ? t('setup.test.liveMode') : runState === 'replay' ? t('setup.test.replayMode') : ''}</span>
          </div>
        </div>
        <label className="setup-switch test-panel__recording">
          <input
            type="checkbox"
            checked={testRecordingEnabled}
            onChange={(e): void => setTestRecordingEnabled(e.currentTarget.checked)}
          />
          <span>{testRecordingEnabled ? t('setup.test.recordingOn') : t('setup.test.recordingOff')}</span>
        </label>
        <div className="test-panel__live">
          <button
            type="button"
            className={liveMicRunning ? 'btn btn-primary' : 'btn btn-secondary'}
            onClick={(): void => { void (liveMicRunning ? stopLiveMic() : startLiveMic()); }}
          >
            {liveMicRunning ? t('setup.test.stopLiveMic') : t('setup.test.startLiveMic')}
          </button>
          <span>{t('setup.test.liveMicHint')}</span>
        </div>
        <LiveWaveform samples={waveform} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <TestCard
          name={t('setup.test.directionA')}
          explain={t('setup.test.directionAExplain')}
          buttonLabel={t('setup.test.runTestA')}
          result={resA}
          onRun={runA}
        />
        <TestCard
          name={t('setup.test.directionB')}
          explain={t('setup.test.directionBExplain')}
          buttonLabel={t('setup.test.runTestB')}
          result={resB}
          onRun={runB}
        />
      </div>

      {skipped && !allPassed && (
        <div style={{ padding: 10, background: 'rgba(245,158,11,0.1)', color: 'var(--warning)', borderRadius: 6, fontSize: 12, marginBottom: 16 }}>
          {t('setup.test.skipWarning')}
        </div>
      )}

      <div className="setup-footer">
        <button className="btn btn-ghost" onClick={back}>{t('common.back')}</button>
        <div style={{ display: 'flex', gap: 8 }}>
          {!allPassed && !skipped && (
            <button className="btn btn-ghost" onClick={(): void => setSkipped(true)}>
              {t('setup.test.skip')}
            </button>
          )}
          <button className="btn btn-primary" disabled={!canFinish} onClick={(): void => { void concluir(); }}>
            {mode === 'edit' ? t('common.close') : t('setup.test.finish')}
          </button>
        </div>
      </div>

      <ConfirmModal
        open={confirmOpen}
        message={t('setup.test.confirmHeardPt')}
        confirmLabel={t('common.yes')}
        cancelLabel={t('common.no')}
        onConfirm={onConfirmHeard}
        onCancel={onCancelHeard}
      />
    </>
  );
}

function LiveWaveform({ samples }: { samples: WaveformSample[] }): JSX.Element {
  const t = useT();
  const visible = samples.length > 0 ? samples : [{ input: 0, output: 0 }];
  return (
    <div className="live-waveform">
      <div className="live-waveform__legend">
        <span><i className="live-waveform__dot live-waveform__dot--input" />{t('setup.test.input')}</span>
        <span><i className="live-waveform__dot live-waveform__dot--output" />{t('setup.test.output')}</span>
      </div>
      <div className="live-waveform__plot" aria-label={t('setup.test.waveformLabel')}>
        <div className="live-waveform__baseline" />
        {visible.map((sample, index) => (
          <div className="live-waveform__sample" key={`${index}-${sample.input}-${sample.output}`}>
            <span
              className="live-waveform__bar live-waveform__bar--input"
              style={{ height: `${Math.max(2, sample.input * 78)}px` }}
            />
            <span
              className="live-waveform__bar live-waveform__bar--output"
              style={{ height: `${Math.max(2, sample.output * 78)}px` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function pcmRms(base64: string): number {
  const bin = atob(base64);
  if (bin.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < bin.length; i += 2) {
    const lo = bin.charCodeAt(i);
    const hi = bin.charCodeAt(i + 1);
    const value = ((hi << 8) | lo);
    const signed = value >= 0x8000 ? value - 0x10000 : value;
    const normalized = signed / 0x8000;
    sum += normalized * normalized;
    count += 1;
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, count)) * 3);
}

function TestCard({
  name, explain, buttonLabel, result, onRun,
}: {
  name: string;
  explain: string;
  buttonLabel: string;
  result: Result;
  onRun: () => Promise<void>;
}): JSX.Element {
  const t = useT();
  return (
    <div style={{ padding: 16, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{name}</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.4 }}>{explain}</div>
      {result.status === 'idle' && (
        <button className="btn btn-secondary" onClick={(): void => { void onRun(); }}>{buttonLabel}</button>
      )}
      {result.status === 'running' && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('setup.test.running')}</div>
      )}
      {result.status === 'passed' && (
        <div style={{ fontSize: 12, color: 'var(--success)' }}>{t('setup.test.passed')}</div>
      )}
      {result.status === 'failed' && (
        <div style={{ fontSize: 12, color: 'var(--error)' }}>{t('setup.test.failed', { reason: result.reason ?? '' })}</div>
      )}
    </div>
  );
}
