import {
  useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction,
} from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, FlaskConical,
  GripVertical, Pencil, Play, Plus, Save, Trash2, X,
} from 'lucide-react';
import {api} from './api';
import type {
  JsonValue, NodeSummary, Pipeline, Step, StepDiagnostic, StepFailurePayload,
  StepKind, StepResult, StreamEvent,
} from '../shared/types';

type Summary = {id: string; name: string; revision: number; stepCount: number; updatedAt: string};

type RunState = {
  runId: number;
  executionId: string | null;
  status: 'running' | 'done' | 'error' | 'idle';
  results: StepResult[];
  failure: StepFailurePayload | null;
};

const emptyRun: RunState = {runId: 0, executionId: null, status: 'idle', results: [], failure: null};

let stepSeq = 0;
const newStep = (kind: StepKind): Step => ({
  id: `new-${Date.now()}-${stepSeq++}`,
  kind,
  source: '',
  target: '',
  sources: [],
  targets: [],
  expression: '',
  separator: kind === 'split' ? ',' : kind === 'merge' ? ' ' : undefined,
  join: kind === 'merge' ? 'join' : undefined,
  onConflict: 'overwrite',
});

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [samples, setSamples] = useState<Record<string, JsonValue>>({});
  const [dirty, setDirty] = useState(false);
  const [diagnostics, setDiagnostics] = useState<StepDiagnostic[]>([]);
  const [saveBanner, setSaveBanner] = useState<null | {kind: 'conflict' | 'saved' | 'saving'; text?: string; server?: Pipeline}>(null);
  const [sampleName, setSampleName] = useState('sample');
  const [editing, setEditing] = useState<string | null>(null);
  const [run, setRun] = useState<RunState>(emptyRun);

  useEffect(() => { api.list().then(setItems).catch(() => undefined); }, []);

  useEffect(() => {
    if (!pipelineId) return;
    let alive = true;
    api.load(pipelineId).then(p => {
      if (!alive) return;
      setPipeline({id: p.id, name: p.name, revision: p.revision, updatedAt: p.updatedAt, steps: p.steps});
      setSamples(p.samples ?? {});
      setDiagnostics([]);
      setRun(emptyRun);
      setDirty(false);
      setSaveBanner(null);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [pipelineId]);

  const updateSteps = useCallback((mutate: (steps: Step[]) => Step[]) => {
    setPipeline(p => (p ? {...p, steps: mutate(p.steps)} : p));
    setDirty(true);
    setSaveBanner(null);
    // Any previous preview described an older ordering and must be cleared.
    setRun(emptyRun);
  }, []);

  // Debounced validation — path references are re-checked against the shape
  // produced by preceding steps, so every reorder triggers a fresh pass.
  useEffect(() => {
    if (!pipeline || !dirty) return;
    const t = setTimeout(() => {
      api.validate(pipeline.id, pipeline.steps, samples[sampleName] ?? null)
        .then(r => setDiagnostics(r.diagnostics))
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [pipeline, dirty, samples, sampleName]);

  const setName = (name: string) => {
    setPipeline(p => (p ? {...p, name} : p));
    setDirty(true);
    setSaveBanner(null);
  };

  async function save() {
    if (!pipeline) return;
    setSaveBanner({kind: 'saving'});
    try {
      const saved = await api.save(pipeline.id, pipeline.revision, {
        name: pipeline.name, steps: pipeline.steps,
      });
      setPipeline({...saved});
      setDirty(false);
      setSaveBanner({kind: 'saved', text: `Saved at revision ${saved.revision}`});
      setItems(await api.list());
    } catch (err) {
      const e = err as {status?: number; body?: {current?: Pipeline}};
      if (e.status === 409 && e.body?.current) {
        setSaveBanner({kind: 'conflict', server: e.body.current, text: 'Another client saved newer changes.'});
      } else {
        setSaveBanner({kind: 'conflict', text: (err as Error).message});
      }
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20}/><strong>Payload Migration Studio</strong>
        <small>旧 API 对象 → 新 schema · 流水线预览工作台</small>
        <span className="spacer"/>
        {pipeline && <span className="rev">rev {pipeline.revision}{dirty ? ' · 未保存' : ''}</span>}
      </header>
      <section className="workspace">
        <aside className="pane list-pane">
          <h2>转换流水线</h2>
          <div className="list">
            {items.map(item => (
              <button key={item.id} className={item.id === pipelineId ? 'active' : ''}
                onClick={() => setPipelineId(item.id)}>
                {item.name}
                <br/><small>rev {item.revision} · {item.stepCount} 步</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane steps-pane">
          {pipeline ? (
            <>
              <div className="toolbar">
                <input className="name-input" value={pipeline.name}
                  onChange={e => setName(e.target.value)}/>
                <span className="spacer"/>
                <button className="primary" onClick={save} disabled={!dirty}>
                  <Save size={15}/>保存
                </button>
              </div>

              {saveBanner && <SaveBanner banner={saveBanner}
                onReload={async () => {
                  if (!pipeline) return;
                  const fresh = await api.load(pipeline.id);
                  setPipeline({id: fresh.id, name: fresh.name, revision: fresh.revision, updatedAt: fresh.updatedAt, steps: fresh.steps});
                  setSamples(fresh.samples ?? {});
                  setDirty(false);
                  setDiagnostics([]);
                  setRun(emptyRun);
                  setSaveBanner(null);
                }}
                onKeep={() => {
                  // Retry the same local edits on top of the server's revision.
                  if (saveBanner.server) setPipeline(p => p ? {...p, revision: saveBanner.server!.revision} : p);
                  setSaveBanner({kind: 'saving'});
                  setTimeout(save, 0);
                }}
                onDismiss={() => setSaveBanner(null)}/>}

              <StepList steps={pipeline.steps} diagnostics={diagnostics}
                editing={editing} setEditing={setEditing} updateSteps={updateSteps}/>

              <div className="add-row">
                {(['rename','move','split','merge','compute'] as StepKind[]).map(kind => (
                  <button key={kind} onClick={() => updateSteps(steps => [...steps, newStep(kind)])}>
                    <Plus size={13}/>{kindLabel(kind)}
                  </button>
                ))}
              </div>
            </>
          ) : <p className="muted">从左侧选择一条流水线。</p>}
        </section>

        <aside className="pane preview-pane">
          {pipeline && (
            <PreviewPanel
              pipeline={pipeline}
              samples={samples}
              sampleName={sampleName}
              setSampleName={setSampleName}
              run={run}
              setRun={setRun}
              diagnostics={diagnostics}
            />
          )}
        </aside>
      </section>
    </main>
  );
}

function kindLabel(kind: StepKind): string {
  return {rename: '重命名', move: '移动', split: '拆分', merge: '合并', compute: '表达式'}[kind];
}

// --- save banner ----------------------------------------------------------

function SaveBanner({banner, onReload, onKeep, onDismiss}: {
  banner: {kind: string; text?: string; server?: Pipeline};
  onReload: () => void; onKeep: () => void; onDismiss: () => void;
}) {
  if (banner.kind === 'saving') return <div className="banner info">保存中…</div>;
  if (banner.kind === 'saved') return <div className="banner ok" onClick={onDismiss}>{banner.text}（点击关闭）</div>;
  return (
    <div className="banner conflict">
      <AlertTriangle size={15}/>
      <div>
        <strong>并发冲突：</strong>{banner.text}
        {banner.server && <small> 服务器版本 rev {banner.server.revision}，更新于 {banner.server.updatedAt}</small>}
        <div className="banner-actions">
          <button onClick={onReload}>载入服务器版本（放弃本地）</button>
          <button onClick={onKeep}>基于服务器版本重试保存</button>
          <button onClick={onDismiss}><X size={13}/></button>
        </div>
      </div>
    </div>
  );
}

// --- step list + editor ---------------------------------------------------

function StepList({steps, diagnostics, editing, setEditing, updateSteps}: {
  steps: Step[];
  diagnostics: StepDiagnostic[];
  editing: string | null;
  setEditing: (id: string | null) => void;
  updateSteps: (m: (steps: Step[]) => Step[]) => void;
}) {
  const dragId = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= steps.length) return;
    updateSteps(list => {
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
  };

  return (
    <ol className="steps"
      onDragOver={e => { if (dragId.current) { e.preventDefault(); } }}
      onDrop={() => { dragId.current = null; setOver(null); }}>
      {steps.map((step, i) => {
        const diags = diagnostics.filter(d => d.stepId === step.id || d.index === i);
        const hasError = diags.some(d => d.severity === 'error');
        return (
          <li key={step.id}
            className={`step ${over === step.id ? 'dragover' : ''} ${hasError ? 'has-error' : ''}`}
            draggable
            onDragStart={() => { dragId.current = step.id; }}
            onDragEnter={() => {
              const from = steps.findIndex(s => s.id === dragId.current);
              if (from >= 0 && dragId.current !== step.id) {
                move(from, i);
                setOver(step.id);
              }
            }}
            onDragEnd={() => { dragId.current = null; setOver(null); }}>
            <div className="step-head">
              <GripVertical size={14} className="grip"/>
              <span className="step-index">#{i + 1}</span>
              <span className={`kind kind-${step.kind}`}>{kindLabel(step.kind)}</span>
              <code className="step-summary">{summarizeStep(step)}</code>
              <span className="spacer"/>
              {hasError && <AlertTriangle size={14} className="err-icon"/>}
              <button title="上移" onClick={() => move(i, i - 1)} disabled={i === 0}><ArrowUp size={13}/></button>
              <button title="下移" onClick={() => move(i, i + 1)} disabled={i === steps.length - 1}><ArrowDown size={13}/></button>
              <button title="编辑" onClick={() => setEditing(editing === step.id ? null : step.id)}><Pencil size={13}/></button>
              <button title="删除" onClick={() => updateSteps(list => list.filter(s => s.id !== step.id))}><Trash2 size={13}/></button>
            </div>
            {diags.length > 0 && (
              <ul className="diags">
                {diags.map((d, j) => (
                  <li key={j} className={d.severity}>
                    <strong>{d.code}</strong> {d.message}
                    {d.path && <code> {d.path}</code>}
                  </li>
                ))}
              </ul>
            )}
            {editing === step.id && (
              <StepEditor step={step}
                onChange={next => updateSteps(list => list.map(s => s.id === step.id ? next : s))}/>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function summarizeStep(s: Step): string {
  switch (s.kind) {
    case 'rename': case 'move': return `${s.source ?? '?'} → ${s.target ?? '?'}${s.kind === 'move' && s.deleteSource === false ? ' (复制)' : ''}`;
    case 'split': return `${s.source ?? '?'} ⇒ ${(s.targets ?? []).join(', ') || '?'}`;
    case 'merge': return `${(s.sources ?? []).join(' + ') || '?'} → ${s.target ?? '?'}`;
    case 'compute': return `${s.source ?? '<root>'} = ${s.expression ?? '?'} → ${s.target ?? '?'}`;
  }
}

function Field({label, children}: {label: string; children: ReactNode}) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function StepEditor({step, onChange}: {step: Step; onChange: (s: Step) => void}) {
  const set = (patch: Partial<Step>) => onChange({...step, ...patch});
  const listField = (key: 'sources' | 'targets', value: string) =>
    set({[key]: value.split('\n').map(s => s.trim()).filter(Boolean)} as Partial<Step>);
  return (
    <div className="editor">
      <Field label="描述">
        <input value={step.description ?? ''} placeholder="可选说明" onChange={e => set({description: e.target.value})}/>
      </Field>
      {(step.kind === 'rename' || step.kind === 'move' || step.kind === 'split' || step.kind === 'compute') && (
        <Field label="源路径"><input value={step.source ?? ''} placeholder="$.items[*].name" onChange={e => set({source: e.target.value})}/></Field>
      )}
      {step.kind === 'split' && (
        <Field label="目标路径（每行一个）">
          <textarea rows={2} value={(step.targets ?? []).join('\n')} onChange={e => listField('targets', e.target.value)}/>
        </Field>
      )}
      {step.kind === 'merge' && (<>
        <Field label="源路径（每行一个）">
          <textarea rows={2} value={(step.sources ?? []).join('\n')} onChange={e => listField('sources', e.target.value)}/>
        </Field>
      </>)}
      {(step.kind === 'rename' || step.kind === 'move' || step.kind === 'merge' || step.kind === 'compute') && (
        <Field label="目标路径"><input value={step.target ?? ''} placeholder="$.output.name" onChange={e => set({target: e.target.value})}/></Field>
      )}
      {(step.kind === 'split' || step.kind === 'merge') && (
        <Field label="分隔符"><input value={step.separator ?? ''} onChange={e => set({separator: e.target.value})}/></Field>
      )}
      {step.kind === 'merge' && (
        <Field label="合并方式">
          <select value={step.join ?? 'join'} onChange={e => set({join: e.target.value as Step['join']})}>
            <option value="join">字符串拼接</option>
            <option value="concat">数组连接</option>
            <option value="object">对象合并</option>
          </select>
        </Field>
      )}
      {step.kind === 'compute' && (
        <Field label="表达式（v=源值, root, index；isMissing/isNull/upper/coalesce…）">
          <textarea rows={2} value={step.expression ?? ''} onChange={e => set({expression: e.target.value})}/>
        </Field>
      )}
      <div className="editor-row">
        <Field label="目标已存在">
          <select value={step.onConflict ?? 'overwrite'} onChange={e => set({onConflict: e.target.value as Step['onConflict']})}>
            <option value="overwrite">覆盖</option>
            <option value="skip">跳过</option>
            <option value="error">报错中止</option>
          </select>
        </Field>
        <label className="check"><input type="checkbox" checked={!!step.ignoreMissing}
          onChange={e => set({ignoreMissing: e.target.checked})}/>源缺失时不报错</label>
        {step.kind === 'move' && (
          <label className="check"><input type="checkbox" checked={step.deleteSource !== false}
            onChange={e => set({deleteSource: e.target.checked})}/>移动后删除源（取消=复制）</label>
        )}
      </div>
    </div>
  );
}

// --- preview / streaming --------------------------------------------------

function PreviewPanel({pipeline, samples, sampleName, setSampleName, run, setRun}: {
  pipeline: Pipeline;
  samples: Record<string, JsonValue>;
  sampleName: string;
  setSampleName: (n: string) => void;
  run: RunState;
  setRun: Dispatch<SetStateAction<RunState>>;
  diagnostics: StepDiagnostic[];
}) {
  const runSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);

  async function runPreview() {
    // Cancel any in-flight preview belonging to an older ordering.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++runSeq.current;
    setBusy(true);
    setRun({...emptyRun, runId: seq, status: 'running'});
    try {
      for await (const ev of api.execute(pipeline.id, {
        steps: pipeline.steps, revision: pipeline.revision, sample: sampleName,
      }, controller.signal) as AsyncIterable<StreamEvent>) {
        if (seq !== runSeq.current) break; // stale stream: never touch current state
        handleEvent(ev, seq, setRun);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const e = err as {status?: number; body?: {currentRevision?: number}};
      if (seq !== runSeq.current) return;
      if (e.status === 409) {
        setRun(r => ({...r, status: 'error', failure: {
          index: -1, stepId: '', code: 'revision_conflict',
          message: `流水线已被其他人保存（当前 rev ${e.body?.currentRevision}），请刷新后再预览。`,
        }}));
      }
    } finally {
      if (seq === runSeq.current) setBusy(false);
    }
  }

  function handleEvent(ev: StreamEvent, seq: number, setRun: Dispatch<SetStateAction<RunState>>) {
    switch (ev.type) {
      case 'start':
        setRun({runId: seq, executionId: ev.executionId, status: 'running', results: [], failure: null});
        break;
      case 'step': {
        const {type, ...result} = ev;
        void type;
        setRun(r => ({...r, results: [...r.results, result]}));
        break;
      }
      case 'done':
        setRun(r => ({...r, status: 'done'}));
        break;
      case 'error':
        setRun(r => ({...r, status: 'error', failure: ev}));
        break;
    }
  }

  return (
    <>
      <div className="toolbar">
        <select value={sampleName} onChange={e => setSampleName(e.target.value)}>
          {Object.keys(samples).map(n => <option key={n} value={n}>样例：{n}</option>)}
        </select>
        <button className="primary" onClick={runPreview} disabled={busy || pipeline.steps.length === 0}>
          <Play size={15}/>{busy ? '流式执行中…' : '运行预览'}
        </button>
      </div>

      {run.status === 'idle' && <p className="muted">点击运行预览。服务端每完成一步只推送根节点摘要，完整子树按需展开。</p>}

      {run.failure && run.failure.index === -1 && (
        <div className="banner conflict"><AlertTriangle size={15}/>{run.failure.message}</div>
      )}

      {run.failure && run.failure.index >= 0 && (
        <FailureCard failure={run.failure} executionId={run.executionId}/>
      )}

      <ol className="timeline">
        {pipeline.steps.map((step, i) => {
          const result = run.results[i];
          const state = result ? 'applied' : run.failure && run.failure.index === i ? 'failed'
            : run.failure && run.failure.index < i ? 'not-run' : 'pending';
          return (
            <li key={step.id} className={`tl-step tl-${state}`}>
              <div className="tl-head">
                <span className="step-index">#{i + 1}</span>
                <span className={`kind kind-${step.kind}`}>{kindLabel(step.kind)}</span>
                <code>{summarizeStep(step)}</code>
                {result && <small className="dur">{result.durationMs}ms · {result.changes.length} 处变更</small>}
                {state === 'not-run' && <small className="tag">未执行</small>}
                {state === 'failed' && <small className="tag err">失败</small>}
              </div>
              {result && (
                <>
                  <ul className="changes">
                    {result.changes.slice(0, 6).map((c, j) => (
                      <li key={j} className={`change change-${c.op}`}>
                        <span className="op">{c.op}</span> <code>{c.path}</code>
                        {c.from && <> <span className="muted">←</span> <code>{c.from}</code></>}
                        {c.detail && <small> {c.detail}</small>}
                      </li>
                    ))}
                    {result.changes.length > 6 && <li className="muted">…另 {result.changes.length - 6} 处</li>}
                  </ul>
                  <RootSummary summary={result.after} executionId={run.executionId} afterStep={i}/>
                </>
              )}
            </li>
          );
        })}
      </ol>

      {run.status === 'done' && (
        <div className="banner ok">全部 {run.results.length} 步成功。点击上方任一步的根节点可按需展开最终结构。</div>
      )}
      {run.status === 'error' && run.failure && run.failure.index >= 0 && (
        <div className="banner conflict">
          <AlertTriangle size={15}/>
          执行在第 {run.failure.index + 1} 步中止。已应用的 {run.failure.index} 步是<strong>部分前状态</strong>，
          不会作为最终输出返回 —— 展开节点仅用于排查。
        </div>
      )}
    </>
  );
}

// --- summary card with lazy full-tree expansion ---------------------------

function RootSummary({summary, executionId, afterStep}: {
  summary: NodeSummary; executionId: string | null; afterStep: number;
}) {
  const [open, setOpen] = useState(false);
  if (!executionId) return null;
  return (
    <div className="root-summary">
      <button className="expand-btn" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
        {summary.kind === 'object' && `对象 · ${summary.fieldCount} 字段`}
        {summary.kind === 'array' && `数组 · ${summary.length} 元素`}
        {summary.kind === 'scalar' && `标量 (${summary.scalar})`}
        {' '}<small className="muted">{open ? '收起完整节点' : '展开完整节点（按需拉取）'}</small>
      </button>
      {!open && summary.kind === 'object' && (
        <div className="field-preview">
          {summary.fields.map(f => <span key={f.name} className="fp-item"><code>{f.name}</code><em>{f.type}</em></span>)}
          {summary.truncated && <span className="muted">…</span>}
        </div>
      )}
      {!open && summary.kind === 'array' && (
        <div className="field-preview">
          {Object.entries(summary.elementTypes).map(([t, n]) => (
            <span key={t} className="fp-item"><em>{t}</em><code>×{n}</code></span>
          ))}
        </div>
      )}
      {open && <LazyNode executionId={executionId} afterStep={afterStep} path="$" depth={0}/>}
    </div>
  );
}

type NodePayload = {state: 'missing'} | {state: 'value'; value: JsonValue; truncated: boolean};
const nodeCache = new Map<string, NodePayload>();

function LazyNode({executionId, afterStep, path, depth}: {
  executionId: string; afterStep: number; path: string; depth: number;
}) {
  const key = `${executionId}|${afterStep}|${path}`;
  const [data, setData] = useState<NodePayload | undefined>(() => nodeCache.get(key));
  const [loading, setLoading] = useState(!nodeCache.has(key));

  useEffect(() => {
    let alive = true;
    const cached = nodeCache.get(key);
    if (cached) { setData(cached); setLoading(false); return; }
    setLoading(true);
    api.node(executionId, afterStep, path).then(v => {
      if (!alive) return;
      nodeCache.set(key, v);
      setData(v);
      setLoading(false);
    }).catch(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [key, executionId, afterStep, path]);

  if (loading) return <div className="lazy loading">加载 {path} …</div>;
  if (!data) return null;
  if (data.state === 'missing') return <span className="v-missing">missing</span>;
  return (
    <div className="lazy-node">
      {data.truncated && <div className="trunc-note">节点过大，已在服务端截断（上限 5000 节点）。</div>}
      <JsonTree value={data.value!} depth={depth} executionId={executionId} afterStep={afterStep} basePath={path}/>
    </div>
  );
}

function childPath(base: string, name: string, index?: number): string {
  if (index !== undefined) return `${base}[${index}]`;
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `${base}.${name}` : `${base}[${JSON.stringify(name)}]`;
}

function JsonTree({value, depth, executionId, afterStep, basePath}: {
  value: JsonValue; depth: number; executionId: string; afterStep: number; basePath: string;
}) {
  if (value === null) return <span className="v-null">null</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">[]</span>;
    return <Collapsible depth={depth} label={`Array(${value.length})`}>
      {value.map((el, i) => (
        <LazyChild key={i} name={String(i)} index={i} value={el} depth={depth + 1}
          executionId={executionId} afterStep={afterStep} basePath={basePath}/>
      ))}
    </Collapsible>;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return <span className="muted">{'{}'}</span>;
    return <Collapsible depth={depth} label={`{${keys.length}}`}>
      {keys.map(k => (
        <LazyChild key={k} name={k} value={value[k]!} depth={depth + 1}
          executionId={executionId} afterStep={afterStep} basePath={basePath}/>
      ))}
    </Collapsible>;
  }
  return <span className={`v-${typeof value}`}>{JSON.stringify(value)}</span>;
}

/**
 * Children are rendered from the bounded parent payload while inside the
 * bound; expanding a container still re-requests that exact path so a big
 * sibling branch is never shipped until the user asks for it.
 */
function LazyChild({name, index, value, depth, executionId, afterStep, basePath}: {
  name: string; index?: number; value: JsonValue; depth: number;
  executionId: string; afterStep: number; basePath: string;
}) {
  const path = childPath(basePath, name, index);
  const isContainer = value !== null && typeof value === 'object';
  if (!isContainer) {
    return (
      <div className="tree-row" style={{paddingLeft: depth * 14}}>
        <code className="tree-key">{name}</code>: <JsonTree value={value} depth={depth}
          executionId={executionId} afterStep={afterStep} basePath={path}/>
      </div>
    );
  }
  return (
    <div className="tree-row" style={{paddingLeft: depth * 14}}>
      <Collapsible depth={depth} label={<><code className="tree-key">{name}</code>: {Array.isArray(value) ? `Array(${value.length})` : `{${Object.keys(value).length}}`}</>}>
        <LazyNode executionId={executionId} afterStep={afterStep} path={path} depth={depth + 1}/>
      </Collapsible>
    </div>
  );
}

function Collapsible({depth, label, children}: {depth: number; label: ReactNode; children: ReactNode}) {
  const [open, setOpen] = useState(depth < 1);
  return (
    <div>
      <button className="twisty" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}{label}
      </button>
      {open && children}
    </div>
  );
}

// --- failure card ----------------------------------------------------------

function FailureCard({failure, executionId}: {failure: StepFailurePayload; executionId: string | null}) {
  const [showPre, setShowPre] = useState(false);
  return (
    <div className="failure-card">
      <div className="fail-head"><AlertTriangle size={15}/><strong>{failure.code}</strong></div>
      <p>{failure.message}</p>
      <dl>
        <dt>失败步骤</dt><dd>#{failure.index + 1} <code>{failure.stepId}</code></dd>
        {failure.sourcePath && <><dt>源路径</dt><dd><code>{failure.sourcePath}</code></dd></>}
      </dl>
      {executionId && failure.preStatePath && (
        <>
          <button className="expand-btn" onClick={() => setShowPre(o => !o)}>
            {showPre ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
            {showPre ? '收起' : '查看'}该步执行前的源节点（部分前状态 · 按路径拉取）
          </button>
          {showPre && <LazyNode executionId={executionId} afterStep={failure.index - 1}
            path={failure.preStatePath} depth={0}/>}
          {failure.preStateTruncated && showPre && <small className="muted">源节点过大，服务端返回时已截断。</small>}
        </>
      )}
    </div>
  );
}
