// Browser-side API client. Preview reads NDJSON incrementally and every
// preview run is guarded by an abort controller + generation token so a
// response for an old step order can never overwrite a newer one.

import type {JsonValue, PipelineDoc, Step} from '../shared/types';
import type {StepDiagnostic} from '../shared/shape';

async function jsonFetch(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, payload);
  }
  return response;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown
  ) {
    super(`HTTP ${status}`);
  }
  get body(): {error?: string; message?: string; current?: PipelineDoc} {
    return (this.payload ?? {}) as {error?: string; message?: string; current?: PipelineDoc};
  }
}

export const api = {
  sample: async (): Promise<JsonValue> => (await jsonFetch('/api/sample')).json(),

  pipeline: async (): Promise<PipelineDoc> => (await jsonFetch('/api/pipeline')).json(),

  save: async (revision: number, name: string, steps: Step[]): Promise<PipelineDoc> => {
    const response = await jsonFetch('/api/pipeline', {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, name, steps}),
    });
    return response.json();
  },

  validate: async (sample: JsonValue, steps: Step[]): Promise<StepDiagnostic[]> => {
    const response = await jsonFetch('/api/validate', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({sample, steps}),
    });
    return (await response.json()).diagnostics as StepDiagnostic[];
  },

  node: async (sessionId: string, stepIndex: number, path: string): Promise<JsonValue> => {
    const query = new URLSearchParams({stepIndex: String(stepIndex), path});
    const response = await jsonFetch(`/api/preview/${encodeURIComponent(sessionId)}/node?${query}`);
    return (await response.json()).node as JsonValue;
  },
};

export type PreviewEvent =
  | {type: 'start'; sessionId: string; totalSteps: number}
  | {
      type: 'step';
      index: number;
      stepId: string;
      op: string;
      changed: {sources: string[]; targets: string[]};
      summary: unknown;
    }
  | {type: 'done'; outputSummary: unknown}
  | {
      type: 'error';
      failedIndex: number;
      stepId: string;
      code: string;
      message: string;
      sourcePath: string | null;
      preStateSummary: unknown;
      preStateStepIndex: number;
    };

export interface PreviewHandle {
  generation: number;
  abort: () => void;
  done: Promise<void>;
}

/** Runs a streaming preview. `onEvent` only fires while this run is still the
 *  newest one; starting another run aborts and silences the previous one. */
export function streamPreview(
  sample: JsonValue,
  steps: Step[],
  onEvent: (event: PreviewEvent) => void
): PreviewHandle {
  const controller = new AbortController();
  const generation = nextGeneration();
  const run = async () => {
    const response = await fetch('/api/preview', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({sample, steps}),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`preview failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const {value, done} = await reader.read();
      if (!isCurrent(generation)) return; // a newer run superseded this one
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        if (!isCurrent(generation)) return;
        onEvent(JSON.parse(line) as PreviewEvent);
      }
    }
    if (buffer.trim() && isCurrent(generation)) onEvent(JSON.parse(buffer) as PreviewEvent);
  };
  const done = run().catch((error: unknown) => {
    if ((error as {name?: string})?.name === 'AbortError') return;
    if (!isCurrent(generation)) return;
    throw error;
  });
  const handle: PreviewHandle = {
    generation,
    abort: () => controller.abort(),
    done,
  };
  active = handle;
  return handle;
}

let generationCounter = 0;
let active: PreviewHandle | null = null;

function nextGeneration(): number {
  generationCounter += 1;
  if (active) active.abort();
  return generationCounter;
}

function isCurrent(generation: number): boolean {
  return generation === generationCounter;
}
