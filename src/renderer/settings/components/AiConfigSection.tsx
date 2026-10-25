import { ArrowClockwise24Regular, Key24Regular } from '@fluentui/react-icons';
import { Button, Input, Spinner } from '@fluentui/react-components';
import { useEffect, useState, type ReactNode } from 'react';
import type { AiStatus } from '../../../shared/ipc';
import type { Settings } from '../../../shared/settings';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { SettingRow } from './rows';

/** One test run's outcome, kept until the next one so the user can read it. */
type TestResult = { running: true } | { running: false; ok: boolean } | null;

/**
 * The AI explain endpoint card: base URL and model live in settings, the key lives in the OS-encrypted store and is
 * write-only from here. The privacy line always names the host the questions will actually travel to.
 */
export function AiConfigSection({ settings: s, update }: { settings: Settings; update: Update }): ReactNode {
  const t = useText();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult>(null);
  const [baseDraft, setBaseDraft] = useState(s.aiBaseUrl);
  const [modelDraft, setModelDraft] = useState(s.aiModel);
  const [editing, setEditing] = useState<'baseUrl' | 'model' | null>(null);

  // IPC replies can trail the current keystroke. Keep the active input synchronous so its caret is not reset.
  useEffect(() => {
    if (editing !== 'baseUrl') setBaseDraft(s.aiBaseUrl);
    if (editing !== 'model') setModelDraft(s.aiModel);
  }, [s.aiBaseUrl, s.aiModel, editing]);

  const refresh = (): void => {
    void window.settingsApi.getAiStatus().then(setStatus);
  };
  useEffect(refresh, [s.aiBaseUrl, s.aiModel]);

  const endpoint = (() => {
    try {
      return new URL(s.aiBaseUrl).host;
    } catch {
      return null;
    }
  })();
  const complete = s.aiBaseUrl.trim().length > 0 && s.aiModel.trim().length > 0;
  const statusLine = !status
    ? null
    : !status.encryptionAvailable
      ? t.aiSettings.keyNoEncryption
      : status.configured
        ? t.aiSettings.statusOk
        : status.hasKey
          ? t.aiSettings.statusIncomplete
          : t.aiSettings.statusIncomplete;

  const saveKey = async (): Promise<void> => {
    const r = await window.settingsApi.setAiKey(keyDraft);
    setKeyDraft('');
    setKeyMsg(r.ok ? t.aiSettings.keySaved : r.code === 'noEncryption' ? t.aiSettings.keyNoEncryption : t.aiSettings.statusNoKey);
    refresh();
  };
  const removeKey = async (): Promise<void> => {
    await window.settingsApi.clearAiKey();
    setKeyMsg(t.aiSettings.keyRemoved);
    refresh();
  };
  const runTest = async (): Promise<void> => {
    setTest({ running: true });
    const r = await window.settingsApi.testAiConnection();
    setTest({ running: false, ok: r.ok });
  };

  return (
    <>
      <SettingRow icon={<Key24Regular />} title={t.aiSettings.title}>
        <></>
      </SettingRow>
      <SettingRow icon={<ArrowClockwise24Regular />} title={t.aiSettings.baseUrl} description={t.aiSettings.baseUrlDesc}>
        <Input
          value={baseDraft}
          style={{ width: 300 }}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          onFocus={() => setEditing('baseUrl')}
          onBlur={() => setEditing(null)}
          onChange={(_, d) => {
            const next = d.value.slice(0, 200);
            setBaseDraft(next);
            void update({ aiBaseUrl: next });
          }}
        />
      </SettingRow>
      <SettingRow icon={<ArrowClockwise24Regular />} title={t.aiSettings.model} description={t.aiSettings.modelDesc}>
        <Input value={modelDraft} style={{ width: 220 }} spellCheck={false}
          onFocus={() => setEditing('model')} onBlur={() => setEditing(null)}
          onChange={(_, d) => {
            const next = d.value.slice(0, 100);
            setModelDraft(next);
            void update({ aiModel: next });
          }} />
      </SettingRow>
      <SettingRow icon={<Key24Regular />} title={t.aiSettings.keyLabel} description={t.aiSettings.keyDesc}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input type="password" value={keyDraft} style={{ width: 220 }} placeholder={t.aiSettings.keyPlaceholder}
            onChange={(_, d) => setKeyDraft(d.value)} />
          <Button appearance="primary" disabled={keyDraft.length === 0} onClick={() => void saveKey()}>
            {t.aiSettings.keySave}
          </Button>
          <Button disabled={!status?.hasKey} onClick={() => void removeKey()}>{t.aiSettings.keyRemove}</Button>
        </div>
      </SettingRow>
      {(statusLine !== null || keyMsg) && (
        <SettingRow icon={<ArrowClockwise24Regular />} title={keyMsg ?? statusLine ?? ''}>
          <></>
        </SettingRow>
      )}
      <SettingRow icon={<ArrowClockwise24Regular />} title={t.aiSettings.test} description={endpoint ? t.aiSettings.privacy(endpoint) : undefined}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button disabled={!complete || test?.running} onClick={() => void runTest()}>{t.aiSettings.test}</Button>
          {test?.running && <Spinner size="tiny" label={t.aiSettings.testing} />}
          {test && !test.running && (test.ok ? t.aiSettings.testOk : t.aiSettings.testFail)}
        </div>
      </SettingRow>
    </>
  );
}
