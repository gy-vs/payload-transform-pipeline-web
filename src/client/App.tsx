import type {JSX} from 'react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  GripVertical,
  Loader2,
  Play,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import {validateSteps, StepDiagnostic} from '../shared/shape';
import type {SummaryNode} from '../shared/summary';
import type {JsonValue, PipelineDoc, Step} from '../shared/types';
import {ApiError, api, streamPreview, type PreviewEvent} from './api';
import {blankStep, OpPicker, StepEditor} from './StepEditor';
import {SummaryView} from './SummaryView';

interface PreviewRow {
  index: number;
  stepId: string;
  op: string;
  summary: SummaryNode;
  status: 'ok';
}

interface PreviewError {
  failedIndex: number;
  stepId: string;
  message: string;
  sourcePath: string | null;
  preStateSummary: SummaryNode;
  preStateStepIndex: number;
}

interface Conflict {
  serverRevision: number;
  current: PipelineDoc;
}

const OP_META: Record<Step['op'], {label: string}> = {
  rename: {label: 'Rename'},
  move: {label: 'Move'},
  split: {label: 'Split'},
  merge: {label: 'Merge'},
  expression: {label: 'Expression'},
};

function stepSummary(step: Step): string {
  switch (step.op) {
    case 'rename':
    case 'move':
      return `${step.source || '?'} → ${step.target || '?'}`;
    case 'split':
      return `${step.source || '?'} ⇒ ${step.targets.join(', ') || '?'}`;
    case 'merge':
      return `${step.sources.join(' + ') || '?'} → ${step.target || '?'}`;
    case 'expression':
      return step.mapEach ? `map ${step.mapEach}: ${step.expr || '?'}` : `${step.expr || '?'} → ${step.target || '?'}`;
  }
}

export default function App(): JSX.Element {
  const [doc, setDoc] = useState<PipelineDoc | null>(null);
  const [sample, setSample] = useState<JsonValue | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [previewError, setPreviewError] = useState<PreviewError | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  // --- load ----------------------------------------------------------------
  useEffect(() => {
    void Promise.all([api.pipeline(), api.sample()]).then(([pipeline, loadedSample]) => {
      setDoc(pipeline);
      setSteps(pipeline.steps);
      setName(pipeline.name);
      setSample(loadedSample);
      setSelectedId(pipeline.steps[0]?.id ?? null);
    });
  }, []);

  // --- instant structural re-validation (shared engine code, runs in browser)
  const diagnostics: StepDiagnostic[] = useMemo(
    () => (sample ? validateSteps(sample, steps) : []),
    [sample, steps]
  );
  const diagnosticByStep = useMemo(() => {
    const map = new Map<string, StepDiagnostic>();
    for (const diagnostic of diagnostics) map.set(diagnostic.stepId, diagnostic);
    return map;
  }, [diagnostics]);

  // --- streaming preview, debounced; a new order always supersedes the old --
  const schedulePreview = useCallback((nextSteps: Step[]) => {
    if (!sample) return;
    setConflict(null);
    setRunning(true);
    setRows([]);
    setPreviewError(null);
    setSessionId(null);
    const handle = streamPreview(sample, nextSteps, (event: PreviewEvent) => {
      // The client guarantees this callback never fires for a superseded run.
      if (event.type === 'start') {
        setSessionId(event.sessionId);
        return;
      }
      if (event.type === 'step') {
        setRows((previous) => [
          ...previous,
          {index: event.index, stepId: event.stepId, op: event.op, summary: event.summary as SummaryNode, status: 'ok'},
        ]);
        return;
      }
      if (event.type === 'error') {
        setPreviewError({
          failedIndex: event.failedIndex,
          stepId: event.stepId,
          message: event.message,
          sourcePath: event.sourcePath,
          preStateSummary: event.preStateSummary as SummaryNode,
          preStateStepIndex: event.preStateStepIndex,
        });
        setRunning(false);
        return;
      }
      if (event.type === 'done') {
        setRunning(false);
      }
    });
    handle.done.catch((error: unknown) => {
      setNotice((error as Error).message);
      setRunning(false);
    });
  }, [sample]);

  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editSteps = useCallback((updater: (current: Step[]) => Step[]) => {
    setDirty(true);
    setSteps((current) => {
      const next = updater(current);
      if (previewTimer.current) clearTimeout(previewTimer.current);
      previewTimer.current = setTimeout(() => schedulePreview(next), 350);
      return next;
    });
  }, [schedulePreview]);

  // First preview once the sample is loaded.
  const initialPreview = useRef(false);
  useEffect(() => {
    if (sample && steps.length > 0 && !initialPreview.current) {
      initialPreview.current = true;
      schedulePreview(steps);
    }
  }, [sample, steps, schedulePreview]);

  // --- step mutations -------------------------------------------------------
  const selectedStep = steps.find((step) => step.id === selectedId) ?? null;

  const updateSelected = (updated: Step) => {
    editSteps((current) => current.map((step) => (step.id === updated.id ? updated : step)));
  };

  const addStep = (op: Step['op']) => {
    const step = blankStep(op);
    editSteps((current) => [...current, step]);
    setSelectedId(step.id);
    setAdding(false);
  };

  const removeStep = (id: string) => {
    editSteps((current) => current.filter((step) => step.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const moveStep = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    editSteps((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const reorder = (from: number, to: number) => {
    setDragIndex(null);
    setDropTarget(null);
    moveStep(from, to);
  };

  // --- save with optimistic revision ---------------------------------------
  const save = async () => {
    if (!doc) return;
    setSaving(true);
    setConflict(null);
    setNotice(null);
    try {
      const saved = await api.save(doc.revision, name, steps);
      setDoc(saved);
      setSteps(saved.steps);
      setDirty(false);
      setNotice(`Saved as revision ${saved.revision}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.body.current) {
        setConflict({serverRevision: error.body.current.revision, current: error.body.current});
      } else {
        setNotice(`Save failed: ${(error as Error).message}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const adoptServerVersion = () => {
    if (!conflict) return;
    setDoc(conflict.current);
    setSteps(conflict.current.steps);
    setName(conflict.current.name);
    setDirty(false);
    setConflict(null);
    schedulePreview(conflict.current.steps);
  };

  if (!doc || !sample) {
    return <main className="shell"><div className="loading"><Loader2 className="spin" size={18} /> Loading workbench…</div></main>;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <strong>Payload Migration Workbench</strong>
        <input className="name-input" value={name} onChange={(event) => {setName(event.target.value); setDirty(true);}} />
        <span className="revision-pill">rev {doc.revision}{dirty ? ' • unsaved' : ''}</span>
        <button className="primary" onClick={save} disabled={saving || !dirty}>
          {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />} Save
        </button>
      </header>

      {conflict ? (
        <div className="banner conflict">
          <AlertTriangle size={16} />
          <span>
            Concurrent save detected: the pipeline is now at <strong>revision {conflict.serverRevision}</strong>.
            Your changes were based on revision {doc.revision}.
          </span>
          <button onClick={adoptServerVersion}>Load server version & re-apply later</button>
        </div>
      ) : null}
      {notice ? (
        <div className="banner info">
          <CheckCircle2 size={16} /> {notice}
          <button className="banner-close" onClick={() => setNotice(null)}><X size={14} /></button>
        </div>
      ) : null}

      <section className="workspace">
        {/* ---- pipeline column ---- */}
        <section className="pane steps-pane">
          <div className="pane-head">
            <h2>Pipeline ({steps.length} steps)</h2>
            <button className="mini" onClick={() => setAdding(!adding)}><Plus size={14} /> Add step</button>
          </div>
          {adding ? <OpPicker onPick={addStep} /> : null}

          <ol
            className="step-list"
            onDragOver={(event) => event.preventDefault()}
          >
            {steps.map((step, index) => {
              const diagnostic = diagnosticByStep.get(step.id);
              const active = selectedId === step.id;
              const failedHere = previewError?.failedIndex === index;
              return (
                <li
                  key={step.id}
                  className={`step-row ${active ? 'active' : ''} ${diagnostic ? 'invalid' : ''} ${failedHere ? 'failed' : ''} ${dragIndex === index ? 'dragging' : ''} ${dropTarget === index ? 'drop-before' : ''}`}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragEnd={() => {setDragIndex(null); setDropTarget(null);}}
                  onDragOver={(event) => {event.preventDefault(); setDropTarget(index);}}
                  onDrop={(event) => {event.preventDefault(); if (dragIndex !== null) reorder(dragIndex, index);}}
                  onClick={() => setSelectedId(step.id)}
                >
                  <span className="drag-handle" title="Drag to reorder"><GripVertical size={15} /></span>
                  <span className="step-index">{index + 1}</span>
                  <span className={`op-tag op-${step.op}`}>{OP_META[step.op].label}</span>
                  <span className="step-summary" title={stepSummary(step)}>{stepSummary(step)}</span>
                  {diagnostic ? (
                    <span className="row-error" title={`${diagnostic.code}: ${diagnostic.message}${diagnostic.sourcePath ? ` (${diagnostic.sourcePath})` : ''}`}>
                      <AlertTriangle size={14} />
                    </span>
                  ) : null}
                  <span className="row-actions">
                    <button title="Move up" disabled={index === 0} onClick={(event) => {event.stopPropagation(); moveStep(index, index - 1);}}><ArrowUp size={13} /></button>
                    <button title="Move down" disabled={index === steps.length - 1} onClick={(event) => {event.stopPropagation(); moveStep(index, index + 1);}}><ArrowDown size={13} /></button>
                    <button title="Delete" onClick={(event) => {event.stopPropagation(); removeStep(step.id);}}><Trash2 size={13} /></button>
                  </span>
                </li>
              );
            })}
          </ol>

          {diagnostics.length > 0 ? (
            <div className="diagnostics">
              <h3><AlertTriangle size={13} /> Path references re-validated against the current order</h3>
              {diagnostics.map((diagnostic) => (
                <div className="diagnostic" key={`${diagnostic.stepId}-${diagnostic.index}`}>
                  <strong>Step {diagnostic.index + 1}</strong>
                  <code>{diagnostic.sourcePath ?? ''}</code>
                  <span>{diagnostic.message}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        {/* ---- editor column ---- */}
        <section className="pane editor-pane">
          {selectedStep ? (
            <>
              <div className="pane-head">
                <h2>{OP_META[selectedStep.op].label} step</h2>
                <span className="muted">{selectedStep.id}</span>
              </div>
              <StepEditor step={selectedStep} onChange={updateSelected} />
            </>
          ) : (
            <div className="empty-hint">Select or add a step to edit it.</div>
          )}
        </section>

        {/* ---- preview column ---- */}
        <section className="pane preview-pane">
          <div className="pane-head">
            <h2>Preview</h2>
            {running ? <span className="streaming"><Loader2 className="spin" size={13} /> streaming…</span> : <button className="mini" onClick={() => schedulePreview(stepsRef.current)}><Play size={13} /> Re-run</button>}
          </div>
          <div className="preview-rows">
            {rows.map((row) => (
              <div className="preview-row" key={`${row.stepId}-${row.index}`}>
                <div className="preview-row-head">
                  <CheckCircle2 size={13} className="ok-icon" />
                  <span className="step-index">{row.index + 1}</span>
                  <span className={`op-tag op-${row.op}`}>{OP_META[row.op as Step['op']]?.label ?? row.op}</span>
                </div>
                <SummaryView node={row.summary} sessionId={sessionId} stepIndex={row.index} path="$" />
              </div>
            ))}
            {previewError ? (
              <div className="preview-failure">
                <div className="failure-head">
                  <AlertTriangle size={15} />
                  <strong>Step {previewError.failedIndex + 1} failed</strong>
                </div>
                <p>{previewError.message}</p>
                {previewError.sourcePath ? <p className="muted">source path: <code>{previewError.sourcePath}</code></p> : null}
                <p className="warning-note">Execution stopped. There is no final output; below is only a summary of the state before the failed step.</p>
                <SummaryView node={previewError.preStateSummary} sessionId={sessionId} stepIndex={previewError.preStateStepIndex} path="$" />
              </div>
            ) : null}
            {!running && rows.length === steps.length && rows.length > 0 && !previewError ? (
              <div className="final-note">All {steps.length} steps applied — expand any summary above to fetch its full node.</div>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}
