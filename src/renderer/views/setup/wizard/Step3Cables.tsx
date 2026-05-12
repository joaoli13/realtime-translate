import { useEffect, useState, type JSX } from 'react';
import { useT } from '../../../../shared/i18n/I18nProvider';
import { rt } from '../../../ipc/client';
import { navigate } from '../shared/useHashRoute';
import { hasVirtualRoutingReady, isMacAudioInventory } from '../shared/cables';
import type { DeviceInventory } from '../../../../shared/types';

export function Step3Cables({ mode }: { mode?: 'edit' | undefined }): JSX.Element {
  const t = useT();
  const [detected, setDetected] = useState<boolean | null>(null);
  const [inventory, setInventory] = useState<DeviceInventory | undefined>();
  const [toast, setToast] = useState<string | undefined>();
  const [howToOpen, setHowToOpen] = useState(false);

  useEffect(() => {
    rt.listDevices()
      .then((inv) => {
        setInventory(inv);
        setDetected(hasVirtualRoutingReady(inv));
      })
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[step3] listDevices failed', e);
        setDetected(false); // surface as missing rather than wedging on null
      });
  }, []);

  const onRescan = async (): Promise<void> => {
    setToast(undefined);
    try {
      const inv = await rt.listDevices();
      setInventory(inv);
      const ok = hasVirtualRoutingReady(inv);
      setDetected(ok);
      if (!ok) setToast(t(isMacAudioInventory(inv) ? 'setup.cables.macRescanFailToast' : 'setup.cables.rescanFailToast'));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[step3] rescan failed', e);
      setDetected(false);
      setToast(t('setup.cables.rescanFailToast'));
    }
  };

  const proceed = (): void => {
    navigate(mode === 'edit' ? { kind: 'review' } : { kind: 'wizard', step: 4 });
  };
  const back = (): void => {
    navigate(mode === 'edit' ? { kind: 'review' } : { kind: 'wizard', step: 2 });
  };

  if (detected === null) {
    return <div style={{ padding: 32, color: 'var(--text-secondary)' }}>{t('setup.cables.detecting')}</div>;
  }

  const isMac = isMacAudioInventory(inventory);
  const link = isMac
    ? 'https://existential.audio/blackhole/'
    : 'https://vb-audio.com/Cable/index.htm#DownloadCableAB';

  return (
    <>
      <div className="setup-step-meta">{t('setup.stepLabel', { n: 3, total: 6 })} — {t('setup.cables.label')}</div>
      {detected ? (
        <>
          <h1 className="setup-heading">{t(isMac ? 'setup.cables.macDetectedHeading' : 'setup.cables.detectedHeading')}</h1>
          <p className="setup-sub">{t(isMac ? 'setup.cables.macDetectedSub' : 'setup.cables.detectedSub')}</p>
        </>
      ) : (
        <>
          <h1 className="setup-heading">{t(isMac ? 'setup.cables.macMissingHeading' : 'setup.cables.missingHeading')}</h1>
          <p className="setup-sub">{t(isMac ? 'setup.cables.macMissingSub' : 'setup.cables.missingSub')}</p>
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginRight: 12 }}
            onClick={(): void => {
              void rt.openExternalUrl(link);
            }}
          >
            {t(isMac ? 'setup.cables.macDownloadButton' : 'setup.cables.downloadButton')}
          </button>
          <button className="btn btn-secondary" onClick={(): void => { void onRescan(); }}>
            {t('setup.cables.rescanButton')}
          </button>
          {toast && (
            <div style={{ marginTop: 16, padding: 10, background: 'rgba(245,158,11,0.1)', color: 'var(--warning)', borderRadius: 6, fontSize: 12 }}>
              {toast}
            </div>
          )}

          <details style={{ marginTop: 24 }} open={howToOpen} onToggle={(e): void => setHowToOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary style={{ fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              {t('setup.cables.howToToggle')}
            </summary>
            <ol style={{ marginTop: 12, paddingLeft: 20, fontSize: 12, color: 'var(--text-tertiary)' }}>
              <li style={{ marginBottom: 4 }}>{t(isMac ? 'setup.cables.macInstallStep1' : 'setup.cables.installStep1')}</li>
              <li style={{ marginBottom: 4 }}>{t(isMac ? 'setup.cables.macInstallStep2' : 'setup.cables.installStep2')}</li>
              <li style={{ marginBottom: 4 }}>{t(isMac ? 'setup.cables.macInstallStep3' : 'setup.cables.installStep3')}</li>
              <li style={{ marginBottom: 4 }}>{t(isMac ? 'setup.cables.macInstallStep4' : 'setup.cables.installStep4')}</li>
            </ol>
          </details>
        </>
      )}

      <div className="setup-footer">
        <button className="btn btn-ghost" onClick={back}>{t('common.back')}</button>
        <button className="btn btn-primary" disabled={!detected} onClick={proceed}>
          {mode === 'edit' ? t('common.saveAndBack') : t('common.next')}
        </button>
      </div>
    </>
  );
}
