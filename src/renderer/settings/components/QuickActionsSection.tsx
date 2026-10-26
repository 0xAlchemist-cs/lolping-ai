import { Button, Dropdown, Field, Input, Option, Spinner, Switch } from '@fluentui/react-components';
import { Flash24Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { ALL_PINGS, pingById, textureUrl, type PingId } from '../../../shared/pings';
import { normalizeQuickActionUrl, type ActionPingId, type QuickActionBinding, type QuickActionDraft } from '../../../shared/quickActions';
import type { Settings } from '../../../shared/settings';
import { api } from '../api';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { SwitchRow } from './rows';

type Kind = QuickActionDraft['target']['kind'];
interface Draft {
  enabled: boolean;
  name: string;
  kind: Kind;
  url: string;
  exePath: string;
  programToken?: string;
}

const draftFrom = (binding: QuickActionBinding | undefined): Draft => ({
  enabled: binding?.enabled ?? true,
  name: binding?.name ?? '',
  kind: binding?.target.kind ?? 'web',
  url: binding?.target.kind === 'web' ? binding.target.url : '',
  exePath: binding?.target.kind === 'app' ? binding.target.exePath : '',
});
const fingerprint = (value: unknown): string => JSON.stringify(value);
const defaultName = (value: string): string => Array.from(value).slice(0, 64).join('');
const hostname = (url: string): string => {
  try { return defaultName(new URL(url).hostname); } catch { return ''; }
};

// Match the wheel editor's geometry, without its drag, preview or rearrangement handlers.
const point = (radius: number, angle: number): string => `${150 + radius * Math.sin(angle)},${150 - radius * Math.cos(angle)}`;
const wedge = (index: number): string => {
  const start = ((index - 0.5) * Math.PI) / 4 + 0.035;
  const end = ((index + 0.5) * Math.PI) / 4 - 0.035;
  return `M${point(52, start)} A52,52 0 0 1 ${point(52, end)} L${point(146, end)} A146,146 0 0 0 ${point(146, start)}Z`;
};

/** Windows-only action configuration. The actual ping wheel remains unchanged. */
export function QuickActionsSection({ settings: s, update }: { settings: Settings; update: Update }) {
  const t = useText();
  const [selected, setSelected] = useState<PingId>(s.wheel[0]);
  const [bindings, setBindings] = useState(s.quickActions.bindings);
  useEffect(() => setBindings(s.quickActions.bindings), [s.quickActions]);
  if (api.platform !== 'win') return null;
  const selectedBinding = selected === 'missing' ? undefined : bindings[selected];
  const select = (id: PingId) => setSelected(id);

  return (
    <>
      <SwitchRow icon={<Flash24Regular />} title={t.quickActions.enable} description={t.quickActions.enableDesc}
        checked={s.features.quickActions} onChange={(value) => void update({ features: { ...s.features, quickActions: value } })} />
      <div className="card qaOverview">
        <div className="lbl">{t.quickActions.wheel}<span className="desc">{t.quickActions.wheelDesc}</span></div>
        <p className="desc">{t.quickActions.description}</p>
        <div className="qaOverviewBody">
          <div className="qaWheel" role="group" aria-label={t.quickActions.wheel}>
            <svg viewBox="0 0 300 300" aria-hidden="true">
              {s.wheel.map((id, i) => <path key={i} d={wedge(i)} className={`weWedge${selected === id ? ' hot' : ''}`} />)}
            </svg>
            {s.wheel.map((id, i) => (
              <button type="button" key={i} className="qaSlot" aria-pressed={selected === id}
                aria-label={t.wheelSlotLabel(t.slotNames[i], t.pingNames[id])}
                title={t.pingNames[id]} style={{ left: 150 + 100 * Math.sin(i * Math.PI / 4), top: 150 - 100 * Math.cos(i * Math.PI / 4) }}
                onClick={() => select(id)}>
                <img src={textureUrl(pingById(id)?.icon ?? '')} alt="" />
              </button>
            ))}
          </div>
          <div className="qaPool">
            <div className="wePoolTitle">{t.allPings}</div>
            <span className="desc">{t.quickActions.allPingsDesc}</span>
            <div className="weTiles">
              {ALL_PINGS.map((ping) => (
                <button type="button" key={ping.id} className={`weTile qaTile${selected === ping.id ? ' picked' : ''}`}
                  aria-pressed={selected === ping.id} onClick={() => select(ping.id)}>
                  <img src={textureUrl(ping.icon)} alt="" />{t.pingNames[ping.id]}
                  {ping.id === 'missing' ? <span className="qaReserved">{t.quickActions.reserved}</span> : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {selected === 'missing' ? (
        <div className="card qaEditor">
          <div className="lbl">{t.quickActions.reserved}<span className="desc">{t.quickActions.reservedDesc}</span></div>
          <Button onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}>
            {t.quickActions.openAi}
          </Button>
        </div>
      ) : (
        <BindingEditor key={selected} pingId={selected} saved={selectedBinding}
          onSaved={(settings) => setBindings(settings.quickActions.bindings)} />
      )}
    </>
  );
}

function BindingEditor({ pingId, saved, onSaved }: {
  pingId: ActionPingId;
  saved: QuickActionBinding | undefined;
  onSaved: (settings: Settings) => void;
}) {
  const t = useText();
  const [draft, setDraft] = useState(() => draftFrom(saved));
  const [baseline, setBaseline] = useState(() => fingerprint(draftFrom(saved)));
  const [busy, setBusy] = useState<'picker' | 'mutation' | 'test' | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const alive = useRef(true);
  const revision = useRef(0);
  const pending = useRef(false);
  const nameEdited = useRef(Boolean(saved?.name));
  const dirty = fingerprint(draft) !== baseline;
  const invalidUrl = draft.kind === 'web' && normalizeQuickActionUrl(draft.url) === null;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savedKey = fingerprint(saved);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; revision.current++; };
  }, []);
  useEffect(() => {
    // Settings pushes for other fields must never replace a draft or move its caret.
    if (!dirtyRef.current) {
      const next = draftFrom(saved);
      setDraft(next);
      setBaseline(fingerprint(next));
      nameEdited.current = Boolean(saved?.name);
    }
  }, [savedKey]);

  const edit = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setMessage(null);
  };
  const changeType = (kind: Kind) => {
    if (kind === draft.kind) return;
    revision.current++;
    pending.current = false;
    setBusy(null);
    edit({ kind, url: '', exePath: '', programToken: undefined,
      ...(!nameEdited.current ? { name: kind === 'toggleDesktop' ? t.quickActions.types.toggleDesktop : '' } : {}) });
  };
  const pick = async () => {
    if (pending.current) return;
    pending.current = true;
    const current = ++revision.current;
    setBusy('picker');
    setMessage(null);
    try {
      const selection = await api.pickQuickActionProgram();
      if (!alive.current || current !== revision.current) return;
      if (selection) edit({ exePath: selection.exePath, programToken: selection.token,
        ...(!nameEdited.current ? { name: defaultName(selection.name) } : {}) });
    } catch {
      if (alive.current && current === revision.current) setMessage({ text: t.quickActionErrors.invalidProgram, error: true });
    } finally {
      if (alive.current && current === revision.current) { pending.current = false; setBusy(null); }
    }
  };
  const run = async (operation: 'save' | 'remove' | 'test') => {
    if (pending.current || operation === 'test' && (!saved?.enabled || dirty)) return;
    pending.current = true;
    const current = ++revision.current;
    setBusy(operation === 'test' ? 'test' : 'mutation');
    setMessage(null);
    try {
      if (operation === 'test') {
        const result = await api.testQuickAction(pingId);
        if (alive.current && current === revision.current) setMessage({
          text: result.ok ? t.quickActions.results[result.status] : t.quickActionErrors[result.code], error: !result.ok,
        });
      } else {
        const target: QuickActionDraft['target'] = draft.kind === 'web' ? { kind: 'web', url: draft.url }
          : draft.kind === 'app' ? { kind: 'app', ...(draft.programToken ? { programToken: draft.programToken } : {}) }
            : { kind: 'toggleDesktop' };
        const name = draft.name.trim() || (draft.kind === 'web' ? hostname(draft.url)
          : draft.kind === 'app' ? draft.exePath.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? ''
            : t.quickActions.types.toggleDesktop);
        const result = operation === 'remove' ? await api.removeQuickAction(pingId)
          : await api.saveQuickAction(pingId, { enabled: draft.enabled, name, target });
        if (!alive.current || current !== revision.current) return;
        if (result.ok) {
          const binding = result.settings.quickActions.bindings[pingId];
          const next = draftFrom(binding);
          setDraft(next);
          setBaseline(fingerprint(next));
          nameEdited.current = Boolean(binding?.name);
          onSaved(result.settings);
          setMessage({ text: operation === 'save' ? t.quickActions.saved : t.quickActions.removed, error: false });
        } else setMessage({ text: t.quickActionErrors[result.code], error: true });
      }
    } catch {
      if (alive.current && current === revision.current) setMessage({ text: t.quickActionErrors.helperUnavailable, error: true });
    } finally {
      if (alive.current && current === revision.current) { pending.current = false; setBusy(null); }
    }
  };
  const locked = busy === 'mutation' || busy === 'test';

  return (
    <div className="card qaEditor" data-quick-action={pingId}>
      <div className="lbl">{t.pingNames[pingId]}</div>
      <Switch checked={draft.enabled} label={t.quickActions.enabled} disabled={locked}
        onChange={(_, data) => edit({ enabled: data.checked })} />
      <Field label={t.quickActions.name}>
        <Input value={draft.name} maxLength={64} disabled={locked} onChange={(_, data) => {
          nameEdited.current = true;
          edit({ name: data.value });
        }} />
      </Field>
      <Field label={t.quickActions.type}>
        <Dropdown value={t.quickActions.types[draft.kind]} selectedOptions={[draft.kind]} disabled={locked}
          onOptionSelect={(_, data) => {
            const kind = data.optionValue;
            if (kind === 'web' || kind === 'app' || kind === 'toggleDesktop') changeType(kind);
          }}>
          {(['web', 'app', 'toggleDesktop'] as const).map((kind) => (
            <Option key={kind} value={kind}>{t.quickActions.types[kind]}</Option>
          ))}
        </Dropdown>
      </Field>
      {draft.kind === 'web' ? (
        <Field label={t.quickActions.url} validationState={invalidUrl && draft.url ? 'error' : 'none'}
          validationMessage={invalidUrl && draft.url ? t.quickActionErrors.invalidUrl : undefined}>
          <Input value={draft.url} spellCheck={false} disabled={locked} onChange={(_, data) => edit({ url: data.value,
            ...(!nameEdited.current ? { name: hostname(data.value) } : {}) })} />
        </Field>
      ) : draft.kind === 'app' ? (
        <>
          <Field label={t.quickActions.program}>
            <div className="qaProgram">
              <Input value={draft.exePath} readOnly placeholder={t.quickActions.noProgram} />
              <Button disabled={busy !== null} onClick={() => void pick()}>{t.quickActions.chooseProgram}</Button>
            </div>
          </Field>
          <span className="desc">{t.quickActions.appNote}</span>
        </>
      ) : null}
      <div className="qaButtons">
        <Button appearance="primary" disabled={busy !== null || invalidUrl || draft.kind === 'app' && !draft.exePath}
          onClick={() => void run('save')}>{t.quickActions.save}</Button>
        <Button disabled={busy !== null || !saved?.enabled || dirty} onClick={() => void run('test')}>{t.quickActions.test}</Button>
        <Button disabled={busy !== null || !saved} onClick={() => void run('remove')}>{t.quickActions.remove}</Button>
        {busy ? <Spinner size="tiny" label={t.quickActions.working} /> : null}
      </div>
      {dirty ? <span className="desc">{t.quickActions.unsaved}</span> : null}
      {message ? <div className={message.error ? 'warnText' : ''} role={message.error ? 'alert' : 'status'}>{message.text}</div> : null}
    </div>
  );
}
