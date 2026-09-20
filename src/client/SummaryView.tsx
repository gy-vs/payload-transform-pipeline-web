import type {JSX} from 'react';
import {useState} from 'react';
import type {JsonValue} from '../shared/types';
import type {SummaryNode} from '../shared/summary';
import {api} from './api';

// --- summary rendering ------------------------------------------------------

const kindBadge = (kind: SummaryNode['kind'], size: number): string => {
  switch (kind) {
    case 'array': return `[${size}]`;
    case 'object': return `{${size}}`;
    case 'null': return 'null';
    default: return kind;
  }
};

/** A clickable summary chip. Object/array summaries can be expanded; the
 *  expansion fetches exactly ONE node of ONE server-side state. */
export function SummaryView(props: {
  node: SummaryNode;
  sessionId: string | null;
  stepIndex: number;
  path: string;
}): JSX.Element {
  const {node, sessionId, stepIndex, path} = props;
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<JsonValue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expandable = node.kind === 'object' || node.kind === 'array';
  const canFetch = expandable && sessionId !== null;

  const toggle = async () => {
    if (!expandable) return;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (expanded !== null || !canFetch) return;
    setLoading(true);
    setError(null);
    try {
      setExpanded(await api.node(sessionId as string, stepIndex, path));
    } catch (fetchError) {
      setError((fetchError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="summary">
      <button
        className={`summary-head ${expandable ? 'expandable' : ''}`}
        onClick={toggle}
        disabled={!canFetch}
        title={canFetch ? `fetch full node at ${path}` : path}
      >
        {expandable ? <span className="twisty">{open ? '▾' : '▸'}</span> : <span className="twisty" />}
        <span className={`kind kind-${node.kind}`}>{kindBadge(node.kind, node.size)}</span>
        {node.kind === 'string' ? (
          <span className="preview-string">
            “{node.preview as string}
            {node.truncated ? '…' : ''}”
            {node.truncated ? <em> ({node.size} chars)</em> : null}
          </span>
        ) : node.kind === 'number' || node.kind === 'boolean' ? (
          <span className="preview-scalar">{String(node.preview)}</span>
        ) : null}
        <span className="summary-path">{path}</span>
      </button>

      {open && node.kind === 'object' ? (
        <div className="summary-children">
          {loading ? <span className="muted">loading…</span> : null}
          {error ? <span className="error-text">{error}</span> : null}
          {expanded !== null ? renderFull(expanded, path, sessionId, stepIndex, 0) : null}
          {!loading && expanded === null && !error ? (
            <ul className="preview-fields">
              {node.fields?.map((field) => (
                <li key={field.name}>
                  <InlineSummary node={field.node} name={field.name} />
                </li>
              )) ?? null}
              {node.hasMore ? <li className="muted">…more fields — expand to load</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      {open && node.kind === 'array' ? (
        <div className="summary-children">
          {loading ? <span className="muted">loading…</span> : null}
          {expanded !== null ? renderFull(expanded, path, sessionId, stepIndex, 0) : null}
          {!loading && expanded === null ? (
            <ul className="preview-fields">
              {node.items?.map((item, index) => (
                <li key={index}>
                  <span className="index-tag">[{index}]</span>
                  <InlineSummary node={item} name={`${path}[${index}]`} />
                </li>
              )) ?? null}
              {node.hasMore && node.items && node.size > node.items.length ? (
                <li className="muted">…{node.size - node.items.length} more elements — expand to load</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A non-fetchable compact summary used inside the pre-fetch preview list. */
function InlineSummary(props: {node: SummaryNode; name: string}): JSX.Element {
  const {node, name} = props;
  return (
    <span className="inline-summary">
      <span className={`kind kind-${node.kind}`}>{kindBadge(node.kind, node.size)}</span>
      <code>{name}</code>
      {node.kind === 'string' ? <span className="muted"> “{node.preview as string}{node.truncated ? '…' : ''}”</span> : null}
      {node.kind === 'number' || node.kind === 'boolean' ? <span className="muted"> {String(node.preview)}</span> : null}
    </span>
  );
}

// --- full node (fetched on demand) -----------------------------------------

function childPath(parent: string, key: string | number): string {
  return typeof key === 'number' ? `${parent}[${key}]` : joinKey(parent, key);
}

function joinKey(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}["${key}"]`;
}

function renderFull(value: JsonValue, path: string, sessionId: string | null, stepIndex: number, depth: number): JSX.Element {
  if (value === null) return <span className="json-null">null</span>;
  if (Array.isArray(value)) {
    return (
      <Collapsible
        depth={depth}
        header={<><span className="kind kind-array">[{value.length}]</span> {path}</>}
        defaultOpen={depth < 1}
      >
        {value.map((child, index) => (
          <div className="json-line" key={index}>
            <span className="index-tag">[{index}]</span>
            {renderFull(child, childPath(path, index), sessionId, stepIndex, depth + 1)}
          </div>
        ))}
      </Collapsible>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return (
      <Collapsible
        depth={depth}
        header={<><span className="kind kind-object">{`{${entries.length}}`}</span> {path}</>}
        defaultOpen={depth < 1}
      >
        {entries.map(([key, child]) => (
          <div className="json-line" key={key}>
            <span className="json-key">{key}</span>
            <span className="json-colon">: </span>
            {renderFull(child, childPath(path, key), sessionId, stepIndex, depth + 1)}
          </div>
        ))}
      </Collapsible>
    );
  }
  if (typeof value === 'string') return <span className="json-string">"{value}"</span>;
  return <span className={`json-${typeof value}`}>{String(value)}</span>;
}

function Collapsible(props: {header: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; depth: number}): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div className="full-node">
      <button className="full-node-head" onClick={() => setOpen(!open)}>
        <span className="twisty">{open ? '▾' : '▸'}</span>
        {props.header}
      </button>
      {open ? <div className="full-node-body">{props.children}</div> : null}
    </div>
  );
}
