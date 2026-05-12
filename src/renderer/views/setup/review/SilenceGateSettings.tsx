import type { JSX } from 'react';
import { useT } from '../../../../shared/i18n/I18nProvider';
import { normalizeSilenceGatePrefs } from '../../../../shared/types';
import { useStore } from '../../../state/store';

export function SilenceGateSettings(): JSX.Element {
  const t = useT();
  const { silenceGatePrefs, setSilenceGatePrefs } = useStore();

  return (
    <section className="recording-settings">
      <div className="recording-settings__header">
        <div>
          <div className="recording-settings__title">{t('silenceGate.title')}</div>
          <div className="recording-settings__sub">{t('silenceGate.sub')}</div>
        </div>
        <label className="setup-switch">
          <input
            type="checkbox"
            checked={silenceGatePrefs.enabled}
            onChange={(e): void =>
              setSilenceGatePrefs(normalizeSilenceGatePrefs({ enabled: e.currentTarget.checked }))
            }
          />
          <span>{silenceGatePrefs.enabled ? t('silenceGate.enabled') : t('silenceGate.disabled')}</span>
        </label>
      </div>
    </section>
  );
}
