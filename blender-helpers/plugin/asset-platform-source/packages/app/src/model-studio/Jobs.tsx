// Model Studio jobs (task; Aurora model-studio-fullpage-v1 "Jobs and results") — the ONE place
// job progress is drawn. A card per job this page is watching: op · source · a state dot + word
// (waiting for GPU = hollow sky · queued/running = sky · done = lime · failed = coral · cancelled = dim),
// phase + % + elapsed, a 3px sky meter, the last log line (click = the whole tail). Cancel is a ghost
// button with no confirm; a failure shows its reason in coral + Retry; done offers Show result.
// Below: the core's log (GET /api/jobs) as compact history rows.
import { useEffect, useState } from 'react';
import { cancelJob, fmtAge, fmtClock, isActive, jobTitle, retryJob, stateOf, toggleLog, useJobs, type HistEntry, type JobState, type Tracked } from './api';

export interface ShowResult { jobId: string; assetIds: string[] }
const WORD: Record<JobState, string> = { waiting: 'waiting for GPU', queued: 'queued', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled', unknown: 'unknown' };
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

export function JobsPanel({ onShowResult, shown }: { onShowResult: (r: ShowResult) => void; shown: string | null }) {
  const { tracked, history, core } = useJobs();
  const [now, setNow] = useState(Date.now());
  const anyActive = tracked.some(t => isActive(stateOf(t)));
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyActive]);

  const waiting = tracked.filter(t => t.local === 'waiting-gpu').reverse();   // oldest first = first in line
  const carded = new Set(tracked.map(t => t.jobId));
  const rows = history.filter(h => !carded.has(h.jobId));
  const active = tracked.filter(t => isActive(stateOf(t))).length;

  return (
    <>
      <div className="ms-lbl">Jobs<span className="sp" /><span className="ms-lbl-note">{active ? `${active} running` : ''}</span></div>
      {core === 'down' && <p className="ms-quiet">Jobs appear here once Model Studio is running.</p>}
      {core !== 'down' && !tracked.length && !rows.length && <p className="ms-quiet">No jobs yet. Pick an operation and Run; jobs keep going while you're in the Library.</p>}
      {tracked.map(t => <JobCard key={t.key} t={t} now={now} line={waiting.indexOf(t) + 1} shown={shown} onShowResult={onShowResult} />)}
      {rows.length > 0 && (
        <>
          <div className="ms-lbl">History</div>
          <div className="ms-hist" data-testid="ms-history">
            {rows.map(h => <HistRow key={h.jobId} h={h} now={now} onShowResult={onShowResult} />)}
          </div>
        </>
      )}
    </>
  );
}

function JobCard({ t, now, line, shown, onShowResult }: { t: Tracked; now: number; line: number; shown: string | null; onShowResult: (r: ShowResult) => void }) {
  const st = stateOf(t), j = t.job, title = jobTitle(t);
  const start = j?.created ? j.created * 1000 : t.at;
  const end = isActive(st) ? now : j?.updated ? j.updated * 1000 : now;
  const elapsed = fmtClock(Math.max(0, (end - start) / 1000));
  const log = (j?.log_tail || '').split('\n').map(s => s.trim()).filter(Boolean);
  const ids = j?.result?.assetIds || [];
  const phase = st === 'waiting' ? (t.local ? 'Waiting for the GPU · held by this page, keep it open' : 'Queued for the GPU')
    : st === 'done' ? `Finished · ${ids.length} output${ids.length === 1 ? '' : 's'}`
    : j?.phase || (st === 'queued' ? 'Queued' : '');
  const why = t.error || j?.error;
  return (
    <div className={`ms-job ${st}`} data-testid="ms-job" data-state={st}>
      <div className="top"><b title={`${title.op} · ${title.source}`}>{title.op}{title.source && ` · ${title.source}`}</b><span className="st"><i />{WORD[st]}</span></div>
      {st !== 'failed' && st !== 'cancelled' && (
        <div className="ph"><span>{phase}</span><span>{st === 'running' && typeof j?.pct === 'number' ? `${Math.round(j.pct)}% · ` : ''}{elapsed}</span></div>
      )}
      {st === 'running' && <div className="ms-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={j?.pct ?? undefined}><i style={{ width: `${Math.max(2, Math.min(100, j?.pct ?? 0))}%` }} /></div>}
      {st === 'failed' && <div className="why">{why || 'The job failed without a reason.'}</div>}
      {log.length > 0 && (t.logOpen
        ? <pre className="ms-log open" onClick={() => toggleLog(t.key)}>{log.join('\n')}</pre>
        : <button className="ms-log" onClick={() => toggleLog(t.key)} aria-expanded={false} title="Show the log tail">{log[log.length - 1]}</button>)}
      <div className="acts">
        {isActive(st) && <button className="ms-btn" onClick={() => cancelJob(t)} data-testid="ms-cancel">Cancel</button>}
        {st === 'failed' && <button className="ms-btn" onClick={() => retryJob(t)} data-testid="ms-retry">Retry</button>}
        {st === 'done' && ids.length > 0 && (
          <button className="ms-btn out" aria-pressed={shown === t.jobId} onClick={() => onShowResult({ jobId: t.jobId!, assetIds: ids })} data-testid="ms-show-result">
            {shown === t.jobId ? 'Showing result' : 'Show result'}</button>
        )}
        {log.length > 0 && <button className="ms-btn" onClick={() => toggleLog(t.key)} aria-expanded={!!t.logOpen}>Log {t.logOpen ? '▾' : '▸'}</button>}
      </div>
    </div>
  );
}

function HistRow({ h, now, onShowResult }: { h: HistEntry; now: number; onShowResult: (r: ShowResult) => void }) {
  const st = h.live ? stateOf({ job: h.live }) : 'unknown';
  const title = jobTitle(h);
  const ids = h.live?.result?.assetIds || [];
  const text = `${title.op}${title.source ? ` · ${title.source}` : ''}`;
  const age = fmtAge(now - (Date.parse(h.at) || now));
  const body = <><i className={`d ${st}`} /><span className="t">{text}</span><span className="a">{age}</span></>;
  return st === 'done' && ids.length
    ? <button className="h" onClick={() => onShowResult({ jobId: h.jobId, assetIds: ids })} title="Show result">{body}</button>
    : <div className="h" title={h.live_error || WORD[st]}>{body}</div>;
}
