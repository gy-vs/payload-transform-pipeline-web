import type {JSX} from 'react';
import {ExpressionStep, MergeStep, Step} from '../shared/types';

export function newStepId(): string {
  return `step_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankStep(op: Step['op']): Step {
  const id = newStepId();
  switch (op) {
    case 'rename':
      return {id, op, source: '', target: ''};
    case 'move':
      return {id, op, source: '', target: ''};
    case 'split':
      return {id, op, source: '', delimiter: ',', targets: ['', '']};
    case 'merge':
      return {id, op, sources: ['', ''], target: '', strategy: 'join', joiner: ' '};
    case 'expression':
      return {id, op, expr: '', target: '', inputs: {}};
  }
}

const OPS: Array<{value: Step['op']; label: string; hint: string}> = [
  {value: 'rename', label: 'Rename', hint: 'change a key name'},
  {value: 'move', label: 'Move', hint: 'relocate to another object'},
  {value: 'split', label: 'Split', hint: 'split a string into targets'},
  {value: 'merge', label: 'Merge', hint: 'join / concat / deep-merge'},
  {value: 'expression', label: 'Expression', hint: 'compute a value'},
];

const inputClass = 'field-input';
const labelClass = 'field-label';

function PathInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  relative?: boolean;
}) {
  return (
    <input
      className={inputClass}
      value={props.value}
      placeholder={props.placeholder ?? (props.relative ? 'field name' : '$.path.to.field')}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

function Checkbox(props: {checked: boolean; onChange: (value: boolean) => void; label: string}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      {props.label}
    </label>
  );
}

export function StepEditor(props: {step: Step; onChange: (step: Step) => void}): JSX.Element {
  const {step, onChange} = props;
  const patch = <T extends Step>(partial: Partial<T>) => onChange({...step, ...partial} as Step);

  return (
    <div className="step-editor">
      {step.op === 'rename' || step.op === 'move' ? (
        <>
          <label className={labelClass}>Source</label>
          <PathInput value={step.source} onChange={(source) => patch({source})} />
          <label className={labelClass}>Target</label>
          <PathInput value={step.target} onChange={(target) => patch({target})} />
          <div className="checkbox-row">
            <Checkbox label="optional (skip if missing)" checked={!!step.optional} onChange={(optional) => patch({optional})} />
            <Checkbox label="overwrite target" checked={!!step.overwrite} onChange={(overwrite) => patch({overwrite})} />
          </div>
          <p className="hint">
            Wildcards map arrays: <code>$.items[*].old_key</code> → <code>$.items[*].newKey</code>
          </p>
        </>
      ) : null}

      {step.op === 'split' ? (
        <>
          <label className={labelClass}>Source (string)</label>
          <PathInput value={step.source} onChange={(source) => patch({source})} />
          <label className={labelClass}>Delimiter</label>
          <input
            className={inputClass}
            value={step.delimiter}
            onChange={(event) => patch({delimiter: event.target.value})}
          />
          <label className={labelClass}>Targets</label>
          {step.targets.map((target, index) => (
            <div className="target-row" key={index}>
              <PathInput value={target} onChange={(value) => {
                const targets = [...step.targets];
                targets[index] = value;
                patch({targets});
              }} />
            </div>
          ))}
          <button className="mini" onClick={() => patch({targets: [...step.targets, '']})}>+ target</button>
          <button
            className="mini"
            disabled={step.targets.length <= 1}
            onClick={() => patch({targets: step.targets.slice(0, -1)})}
          >
            − last target
          </button>
          <div className="checkbox-row">
            <Checkbox label="keep source" checked={!!step.keepSource} onChange={(keepSource) => patch({keepSource})} />
            <Checkbox label="overwrite targets" checked={!!step.overwrite} onChange={(overwrite) => patch({overwrite})} />
            <Checkbox label="extra parts → last target" checked={!!step.extraIntoLast} onChange={(extraIntoLast) => patch({extraIntoLast})} />
          </div>
        </>
      ) : null}

      {step.op === 'merge' ? (
        <>
          <label className={labelClass}>Sources</label>
          {step.sources.map((source, index) => (
            <div className="target-row" key={index}>
              <PathInput value={source} onChange={(value) => {
                const sources = [...step.sources];
                sources[index] = value;
                patch({sources});
              }} />
              <Checkbox
                label="optional"
                checked={step.optionalSources?.includes(source) ?? false}
                onChange={(checked) => {
                  const set = new Set(step.optionalSources ?? []);
                  if (checked) set.add(source); else set.delete(source);
                  patch({optionalSources: [...set]});
                }}
              />
            </div>
          ))}
          <button className="mini" onClick={() => patch({sources: [...step.sources, '']})}>+ source</button>
          <label className={labelClass}>Strategy</label>
          <select className={inputClass} value={step.strategy} onChange={(event) => patch({strategy: event.target.value as MergeStep['strategy']})}>
            <option value="join">join (strings)</option>
            <option value="concat">concat (arrays)</option>
            <option value="deep">deep merge (objects)</option>
          </select>
          {step.strategy === 'join' ? (
            <>
              <label className={labelClass}>Joiner</label>
              <input className={inputClass} value={step.joiner ?? ' '} onChange={(event) => patch({joiner: event.target.value})} />
            </>
          ) : null}
          <label className={labelClass}>Target</label>
          <PathInput value={step.target} onChange={(target) => patch({target})} />
        </>
      ) : null}

      {step.op === 'expression' ? (
        <>
          <label className={labelClass}>Expression</label>
          <textarea
            className="field-input expr"
            rows={2}
            value={step.expr}
            placeholder={'upper(name) + " <" + email + ">"'}
            onChange={(event) => patch({expr: event.target.value})}
          />
          <p className="hint">
            Functions: <code>upper lower trim coalesce concat includes length round strpad join number string</code>.
            <br />
            <code>null</code> is a value; <code>??</code> falls through it. Inputs that are absent bind to null.
          </p>
          <label className={labelClass}>Inputs (name → path)</label>
          {Object.entries(step.inputs ?? {}).map(([name, path]) => (
            <div className="target-row" key={name}>
              <input className="field-input small" value={name} readOnly />
              <PathInput value={path} onChange={(value) => patch({inputs: {...step.inputs, [name]: value}})} />
              <button className="mini" onClick={() => {
                const inputs = {...step.inputs};
                delete inputs[name];
                patch({inputs});
              }}>
                ×
              </button>
            </div>
          ))}
          <button
            className="mini"
            onClick={() => {
              const name = `v${Object.keys(step.inputs ?? {}).length + 1}`;
              patch({inputs: {...step.inputs, [name]: ''}});
            }}
          >
            + input
          </button>
          <label className={labelClass}>Target</label>
          <PathInput value={step.target} relative={!!step.mapEach} onChange={(target) => patch({target})} />
          <label className={labelClass}>Map each (array path; optional)</label>
          <PathInput value={step.mapEach ?? ''} onChange={(mapEach) => patch({mapEach: mapEach || undefined})} />
          {step.mapEach ? (
            <p className="hint">
              Scope contains <code>item</code> and <code>index</code>; target is a field on each element.
            </p>
          ) : null}
          <div className="checkbox-row">
            <Checkbox label="overwrite target" checked={!!step.overwrite} onChange={(overwrite) => patch({overwrite})} />
          </div>
          <label className={labelClass}>Output type</label>
          <select
            className={inputClass}
            value={step.outputType ?? ''}
            onChange={(event) => patch({outputType: (event.target.value || undefined) as ExpressionStep['outputType']})}
          >
            <option value="">(any)</option>
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
            <option value="object">object</option>
            <option value="array">array</option>
          </select>
        </>
      ) : null}
    </div>
  );
}

export function OpPicker(props: {onPick: (op: Step['op']) => void}): JSX.Element {
  return (
    <div className="op-picker">
      {OPS.map((op) => (
        <button key={op.value} className="op-button" onClick={() => props.onPick(op.value)} title={op.hint}>
          <strong>{op.label}</strong>
          <small>{op.hint}</small>
        </button>
      ))}
    </div>
  );
}
