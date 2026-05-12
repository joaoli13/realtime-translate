import { useState, type JSX } from 'react';
import { normalizeRecordingPrefs, recordingHasAnyArtifact, type RecordingPrefs } from '../../../../shared/types';
import { useT } from '../../../../shared/i18n/I18nProvider';
import { rt } from '../../../ipc/client';
import { useStore } from '../../../state/store';

export function RecordingSettings(): JSX.Element {
  const t = useT();
  const { recordingPrefs, setRecordingPrefs } = useStore();
  const [error, setError] = useState<string | null>(null);

  const update = (patch: Partial<RecordingPrefs>): void => {
    const next = normalizeRecordingPrefs({ ...recordingPrefs, ...patch });
    if (next.enabled && !recordingHasAnyArtifact(next)) {
      setError(t('recording.invalid'));
      return;
    }
    setError(null);
    setRecordingPrefs(next);
  };

  const chooseDir = async (): Promise<void> => {
    const dir = await rt.chooseRecordingOutputDir();
    if (dir) update({ outputDir: dir });
  };

  const openDir = async (): Promise<void> => {
    await rt.openRecordingOutputDir(recordingPrefs.outputDir);
  };

  const canSaveEnabled = !recordingPrefs.enabled || recordingHasAnyArtifact(recordingPrefs);

  return (
    <section className="recording-settings">
      <div className="recording-settings__header">
        <div>
          <div className="recording-settings__title">{t('recording.title')}</div>
          <div className="recording-settings__sub">{t('recording.sub')}</div>
        </div>
        <label className="setup-switch">
          <input
            type="checkbox"
            checked={recordingPrefs.enabled}
            onChange={(e): void => update({ enabled: e.currentTarget.checked })}
          />
          <span>{recordingPrefs.enabled ? t('recording.enabled') : t('recording.disabled')}</span>
        </label>
      </div>

      <div className="recording-settings__grid">
        <label className="setup-check">
          <input
            type="checkbox"
            checked={recordingPrefs.includeInput}
            onChange={(e): void => update({ includeInput: e.currentTarget.checked })}
          />
          {t('recording.input')}
        </label>
        <label className="setup-check">
          <input
            type="checkbox"
            checked={recordingPrefs.includeOutput}
            onChange={(e): void => update({ includeOutput: e.currentTarget.checked })}
          />
          {t('recording.output')}
        </label>
        <label className="setup-check">
          <input
            type="checkbox"
            checked={recordingPrefs.includeMixed}
            onChange={(e): void => update({ includeMixed: e.currentTarget.checked })}
          />
          {t('recording.mixed')}
        </label>
        <label className="setup-check">
          <input
            type="checkbox"
            checked={recordingPrefs.directionA}
            onChange={(e): void => update({ directionA: e.currentTarget.checked })}
          />
          {t('recording.directionA')}
        </label>
        <label className="setup-check">
          <input
            type="checkbox"
            checked={recordingPrefs.directionB}
            onChange={(e): void => update({ directionB: e.currentTarget.checked })}
          />
          {t('recording.directionB')}
        </label>
      </div>

      <label className="setup-field-label" htmlFor="mixedInputPercent">
        {t('recording.mixLabel', { n: recordingPrefs.mixedInputPercent, out: 100 - recordingPrefs.mixedInputPercent })}
      </label>
      <input
        id="mixedInputPercent"
        className="recording-range"
        type="range"
        min={0}
        max={100}
        step={5}
        value={recordingPrefs.mixedInputPercent}
        onChange={(e): void => update({ mixedInputPercent: Number(e.currentTarget.value) })}
      />

      <div className="recording-settings__folder">
        <span title={recordingPrefs.outputDir ?? undefined}>
          {recordingPrefs.outputDir || t('recording.defaultFolder')}
        </span>
        <button className="btn btn-ghost" type="button" onClick={(): void => { void chooseDir(); }}>
          {t('recording.chooseFolder')}
        </button>
        <button className="btn btn-ghost" type="button" onClick={(): void => { void openDir(); }}>
          {t('recording.openFolder')}
        </button>
      </div>

      {!canSaveEnabled && (
        <div className="recording-settings__error">{t('recording.invalid')}</div>
      )}
      {error && <div className="recording-settings__error">{error}</div>}
    </section>
  );
}
