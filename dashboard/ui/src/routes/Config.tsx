import { useEffect, useState } from 'react';
import { Pause, Play, RotateCcw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ApiError, api, postJson } from '@/lib/api';
import type { JsonRecord } from '@/lib/types';
import { useBoard } from '@/hooks/board';
import { useResource } from '@/hooks/useResource';
import { useRuns } from '@/hooks/runs';

type Path = string[];

function titleize(k: string) {
  return k.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^\s*\w/, (c) => c.toUpperCase()).trim();
}

function setByPath(root: JsonRecord, path: Path, value: unknown): JsonRecord {
  if (path.length === 0) return root;
  const [head, ...rest] = path;
  const child = root[head];
  return {
    ...root,
    [head]: rest.length === 0
      ? value
      : setByPath((child && typeof child === 'object' ? child : {}) as JsonRecord, rest, value),
  };
}

const isPlainObject = (v: unknown): v is JsonRecord =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Generic config editor over `config/config.json`: every non-`_` leaf becomes an input
 * (bool → switch, number → number, array → CSV, else text) and `_*` keys render as inline
 * docs. Structure and comments survive a round trip because the edit copy is the parsed
 * document itself, patched immutably — the server then validates it against ConfigSchema.
 */
export function Config() {
  const { data, error, loading, refresh } = useResource<{ config: JsonRecord }>((signal) => api.config(signal));
  const { state } = useBoard();
  const { setPaused } = useRuns();
  const [working, setWorking] = useState<JsonRecord | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (data) setWorking(data.config); }, [data]);

  const paused = state?.automation.paused ?? false;

  async function save() {
    if (!working) return;
    setSaving(true);
    setStatus(null);
    try {
      await postJson('/api/config', working);
      setStatus({ tone: 'ok', text: 'Saved — applies to the next run.' });
      refresh();
    } catch (e) {
      const issues = e instanceof ApiError && e.issues ? ` — ${e.issues.join('; ')}` : '';
      setStatus({ tone: 'err', text: (e instanceof Error ? e.message : String(e)) + issues });
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p role="alert" className="text-[13px] text-critical">Could not load the config: {error}</p>;
  if (loading && !working) {
    return <p className="flex items-center gap-2 text-[13px] text-muted"><Spinner label="Loading config" /> Loading config…</p>;
  }
  if (!working) return null;

  const groups = Object.entries(working).filter(([k]) => k !== '_comment' && !k.startsWith('_'));
  const scalars = groups.filter(([, v]) => !isPlainObject(v));
  const objects = groups.filter(([, v]) => isPlainObject(v));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Kill switch</CardTitle>
            <p className="mt-1.5 mb-0 text-[13px] text-fg-2">
              {paused
                ? 'Paused — new runs are refused with HTTP 423 and active runs were cancelled.'
                : 'Running — the panel will accept new runs.'}
            </p>
          </div>
          <Button variant={paused ? 'approve' : 'danger'} size="md" onClick={() => void setPaused(!paused)}>
            {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
            {paused ? 'Resume Millwright' : 'Pause Millwright'}
          </Button>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Runtime config</CardTitle>
            <p className="mt-1.5 mb-0 text-[13px] text-fg-2">
              {typeof working._comment === 'string' ? working._comment : 'Millwright runtime configuration.'}
            </p>
            <p className="mt-1 mb-0 font-mono text-xs text-muted">millwright/config/config.json</p>
          </div>
        </CardHeader>
        {scalars.length ? (
          <CardBody className="flex flex-col gap-2.5 border-t border-grid pt-3.5">
            {scalars.map(([k, v]) => (
              <Field key={k} name={k} value={v} path={[k]} onChange={(p, val) => setWorking((w) => (w ? setByPath(w, p, val) : w))} />
            ))}
          </CardBody>
        ) : null}
      </Card>

      {objects.map(([k, v]) => (
        <Card key={k}>
          <CardHeader><CardTitle>{titleize(k)}</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-2.5">
            <Group obj={v as JsonRecord} path={[k]} onChange={(p, val) => setWorking((w) => (w ? setByPath(w, p, val) : w))} />
          </CardBody>
        </Card>
      ))}

      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-panel border border-border bg-surface/95 px-4 py-3 shadow-pop backdrop-blur">
        <Button variant="primary" size="md" onClick={() => void save()} disabled={saving}>
          <Save size={14} aria-hidden />{saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button size="md" onClick={() => { setWorking(data?.config ?? null); setStatus(null); }}>
          <RotateCcw size={14} aria-hidden />Reset
        </Button>
        {status ? (
          <span
            role="status"
            className={status.tone === 'ok' ? 'text-[13px] font-semibold text-good' : 'text-[13px] font-semibold text-critical'}
          >
            {status.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Group({
  obj,
  path,
  onChange,
}: {
  obj: JsonRecord;
  path: Path;
  onChange: (path: Path, value: unknown) => void;
}) {
  return (
    <>
      {Object.entries(obj).map(([k, v]) => {
        if (k.startsWith('_')) {
          return <p key={k} className="m-0 text-xs leading-relaxed text-muted">{String(v)}</p>;
        }
        if (isPlainObject(v)) {
          return (
            <fieldset key={k} className="m-0 rounded-[10px] border border-border p-3">
              <legend className="px-1 text-[11px] font-bold uppercase tracking-[.04em] text-fg-2">{titleize(k)}</legend>
              <div className="flex flex-col gap-2.5">
                <Group obj={v} path={[...path, k]} onChange={onChange} />
              </div>
            </fieldset>
          );
        }
        return <Field key={k} name={k} value={v} path={[...path, k]} onChange={onChange} />;
      })}
    </>
  );
}

function Field({
  name,
  value,
  path,
  onChange,
}: {
  name: string;
  value: unknown;
  path: Path;
  onChange: (path: Path, value: unknown) => void;
}) {
  const id = `cfg-${path.join('-')}`;

  if (typeof value === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{titleize(name)}</Label>
        <Switch id={id} checked={value} onCheckedChange={(v) => onChange(path, v)} />
      </div>
    );
  }
  if (typeof value === 'number') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label htmlFor={id}>{titleize(name)}</Label>
        <Input
          id={id}
          type="number"
          step="any"
          value={String(value)}
          className="w-[160px] px-2.5 py-1.5 text-[13px]"
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isNaN(n)) onChange(path, n);
          }}
        />
      </div>
    );
  }
  if (Array.isArray(value)) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label htmlFor={id}>{titleize(name)}</Label>
        <Input
          id={id}
          value={value.join(', ')}
          title="comma-separated"
          className="min-w-[220px] flex-1 px-2.5 py-1.5 text-[13px]"
          onChange={(e) => onChange(path, e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Label htmlFor={id}>{titleize(name)}</Label>
      <Input
        id={id}
        value={value == null ? '' : String(value)}
        className="min-w-[220px] flex-1 px-2.5 py-1.5 text-[13px]"
        onChange={(e) => onChange(path, e.target.value)}
      />
    </div>
  );
}
