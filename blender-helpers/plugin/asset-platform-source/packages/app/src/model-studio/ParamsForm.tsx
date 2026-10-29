// Model Studio parameters (task; Aurora model-studio-fullpage-v1 "Parameters"): a form from a
// JSON Schema profile v1 object (one level, schema order). string → text (multiline → textarea) ·
// integer/number → number field (+ slider when min and max) · boolean → switch · enum → segmented
// (≤ 4) or select · array of scalars → chip field. Validation mirrors the core's checkScalar(), so
// Run is disabled on anything the core would 400 on. Outside the profile → RawParams (JSON).
import { useState } from 'react';
import type { Schema } from './api';

/** Form state: number fields hold the typed string (so "1." can be typed); everything else its value. */
export type Draft = Record<string, unknown>;

const propsOf = (s: Schema | null) => Object.entries(s?.properties || {});
const isNum = (s: Schema) => s.type === 'integer' || s.type === 'number';
/** An enum value as a label: profile v1 has no display names, so 'human' reads "Human" (the value sent is unchanged). */
const show = (o: unknown) => (typeof o === 'string' ? o.charAt(0).toUpperCase() + o.slice(1).replace(/[_-]/g, ' ') : String(o));

export function defaultsOf(schema: Schema | null): Draft {
  const d: Draft = {};
  for (const [k, s] of propsOf(schema)) {
    if (s.enum) d[k] = s.default;
    else if (isNum(s)) d[k] = s.default == null ? '' : String(s.default);
    else if (s.type === 'boolean') d[k] = s.default ?? false;
    else if (s.type === 'array') d[k] = Array.isArray(s.default) ? s.default : [];
    else d[k] = s.default ?? '';
  }
  return d;
}

// One scalar against its schema: [value, null] or [null, reason].
function checkScalar(s: Schema, raw: unknown): [unknown, string | null] {
  let v = raw;
  if (isNum(s) && typeof raw === 'string') {
    if (!raw.trim() || !Number.isFinite(Number(raw))) return [null, 'Enter a number'];
    v = Number(raw);
  }
  if (s.enum) return s.enum.includes(v) ? [v, null] : [null, 'Choose one of the options'];
  if (s.type === 'integer' && !Number.isInteger(v)) return [null, 'Must be a whole number'];
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) return [null, `Must be ${s.minimum} or more`];
    if (typeof s.maximum === 'number' && v > s.maximum) return [null, `Must be ${s.maximum} or less`];
    if (typeof s.multipleOf === 'number' && s.multipleOf > 0 && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) return [null, `Must be a multiple of ${s.multipleOf}`];
  }
  if (typeof v === 'string') {
    const len = [...v].length;
    if (typeof s.minLength === 'number' && len < s.minLength) return [null, `At least ${s.minLength} characters`];
    if (typeof s.maxLength === 'number' && len > s.maxLength) return [null, `At most ${s.maxLength} characters`];
    try { if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) return [null, `Must match ${s.pattern}`]; } catch { /* the backend enforces it */ }
    if (s.format === 'uri') { try { new URL(v); } catch { return [null, 'Must be a full URL']; } }
  }
  return [v, null];
}

/** The params to send + a reason per invalid field. Empty optional fields are left out (the core fills defaults). */
export function validate(schema: Schema | null, draft: Draft): { params: Record<string, unknown>; errors: Record<string, string> } {
  const params: Record<string, unknown> = {}, errors: Record<string, string> = {};
  const required = schema?.required || [];
  for (const [k, s] of propsOf(schema)) {
    const v = draft[k];
    if (s.type === 'array') {
      const list = Array.isArray(v) ? v : [];
      if (typeof s.maxItems === 'number' && list.length > s.maxItems) errors[k] = `At most ${s.maxItems}`;
      else if (list.length || required.includes(k)) params[k] = list;
      continue;
    }
    if (v === undefined || v === '' || v === null) {
      if (required.includes(k)) errors[k] = 'Required';
      continue;
    }
    const [ok, why] = checkScalar(s, v);
    if (why) errors[k] = why; else params[k] = ok;
  }
  return { params, errors };
}

export function ParamsForm({ schema, draft, onDraft, errors }: { schema: Schema; draft: Draft; onDraft: (d: Draft) => void; errors: Record<string, string> }) {
  const put = (k: string, v: unknown) => onDraft({ ...draft, [k]: v });
  return (
    <>
      {propsOf(schema).map(([k, s]) => {
        const id = `ms-p-${k}`, err = errors[k], label = s.title || k;
        return (
          <div key={k} className={`ms-fld${err ? ' bad' : ''}`} data-testid={`ms-param-${k}`}>
            <label htmlFor={id}>{label}</label>
            <Control id={id} s={s} v={draft[k]} label={label} onChange={v => put(k, v)} />
            {err ? <div className="ms-err" role="alert">{err}</div> : s.description && <div className="ms-hint">{s.description}</div>}
            {!err && isNum(s) && typeof s.minimum === 'number' && typeof s.maximum === 'number' && !s.description &&
              <div className="ms-hint">{s.minimum}–{s.maximum}{s.default != null ? ` · default ${s.default}` : ''}</div>}
          </div>
        );
      })}
    </>
  );
}

function Control({ id, s, v, label, onChange }: { id: string; s: Schema; v: unknown; label: string; onChange: (v: unknown) => void }) {
  if (s.enum) {
    const opts = s.enum;
    if (opts.length <= 4) {
      return (
        <div className="ms-seg" id={id} role="group" aria-label={label}>
          {opts.map(o => <button key={String(o)} type="button" aria-pressed={v === o} onClick={() => onChange(o)}>{show(o)}</button>)}
        </div>
      );
    }
    return (
      <select id={id} className="ms-in" value={opts.indexOf(v)} onChange={e => onChange(opts[Number(e.target.value)])}>
        {!opts.includes(v) && <option value={-1}>Choose…</option>}
        {opts.map((o, i) => <option key={String(o)} value={i}>{show(o)}</option>)}
      </select>
    );
  }
  if (s.type === 'boolean') {
    return (
      <span className="ms-sw">
        <input id={id} type="checkbox" role="switch" checked={!!v} onChange={e => onChange(e.target.checked)} />
        <span className="k" aria-hidden="true" />{v ? 'On' : 'Off'}
      </span>
    );
  }
  if (isNum(s)) {
    const range = typeof s.minimum === 'number' && typeof s.maximum === 'number';
    const step = s.multipleOf || (s.type === 'integer' ? 1 : range ? Number(((s.maximum! - s.minimum!) / 100).toPrecision(2)) : 'any');
    const num = <input id={id} className="ms-in" inputMode={s.type === 'integer' ? 'numeric' : 'decimal'} value={String(v ?? '')} onChange={e => onChange(e.target.value)} />;
    if (!range) return num;
    const n = Number(v);
    return (
      <div className="ms-numrow">
        <input type="range" aria-label={`${label} slider`} min={s.minimum} max={s.maximum} step={step}
          value={Number.isFinite(n) && String(v).trim() ? Math.min(s.maximum!, Math.max(s.minimum!, n)) : s.minimum} onChange={e => onChange(e.target.value)} />
        {num}
      </div>
    );
  }
  if (s.type === 'array') return <Chips id={id} s={s} v={Array.isArray(v) ? v : []} onChange={onChange} />;
  if (s.format === 'multiline') return <textarea id={id} className="ms-in" rows={3} value={String(v ?? '')} onChange={e => onChange(e.target.value)} />;
  return <input id={id} className="ms-in" value={String(v ?? '')} maxLength={s.maxLength} onChange={e => onChange(e.target.value)} />;
}

// Array of scalars: Enter adds (checked against items), ✕ or Backspace on an empty field removes.
function Chips({ id, s, v, onChange }: { id: string; s: Schema; v: unknown[]; onChange: (v: unknown) => void }) {
  const [text, setText] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  const item = s.items || { type: 'string' };
  const full = typeof s.maxItems === 'number' && v.length >= s.maxItems;
  const add = () => {
    const t = text.trim();
    if (!t) return;
    const raw = item.type === 'boolean' ? t === 'true' ? true : t === 'false' ? false : t : t;
    const [ok, err] = checkScalar(item, raw);
    if (err) { setWhy(err); return; }
    onChange([...v, ok]); setText(''); setWhy(null);
  };
  return (
    <>
      <div className="ms-chips">
        {v.map((x, i) => (
          <span key={i}>{String(x)}<button type="button" aria-label={`Remove ${String(x)}`} onClick={() => onChange(v.filter((_, j) => j !== i))}>✕</button></span>
        ))}
        <input id={id} value={text} disabled={full} placeholder={full ? `max ${s.maxItems}` : 'add…'} onChange={e => { setText(e.target.value); setWhy(null); }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); add(); }
            else if (e.key === 'Backspace' && !text && v.length) onChange(v.slice(0, -1));
          }} onBlur={add} />
      </div>
      {why && <div className="ms-err">{why}</div>}
    </>
  );
}

/** params_unrenderable: the options as JSON. Returns the parse problem, or null. */
export function rawProblem(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? null : 'Must be a JSON object { … }';
  } catch (e) { return `Not valid JSON: ${(e as Error).message}`; }
}
