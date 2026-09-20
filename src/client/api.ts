import type {
  JsonValue,
  Pipeline,
  PipelineSummary,
  Step,
  StepDiagnostic,
  StreamEvent,
  StepResult,
  StepFailurePayload,
} from '../shared/types';

async function jsonOrThrow(res: Response): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error ?? `request failed: ${res.status}`) as Error & {status: number; body: any};
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  list: async (): Promise<PipelineSummary[]> =>
    fetch('/api/pipelines').then(jsonOrThrow),

  load: async (id: string): Promise<Pipeline & {samples: Record<string, JsonValue>}> =>
    fetch(`/api/pipelines/${id}`).then(jsonOrThrow),

  save: async (
    id: string,
    revision: number,
    patch: {name?: string; steps?: Step[]},
  ): Promise<Pipeline> =>
    fetch(`/api/pipelines/${id}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({...patch, revision}),
    }).then(jsonOrThrow),

  validate: async (
    id: string,
    steps: Step[],
    sample?: JsonValue,
  ): Promise<{ok: boolean; revision: number | null; diagnostics: StepDiagnostic[]}> =>
    fetch(`/api/pipelines/${id}/validate`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({steps, ...(sample !== undefined ? {sample} : {})}),
    }).then(jsonOrThrow),

  /**
   * Stream a preview. Caller owns the AbortController so a reorder/run can
   * cancel the stale request — the old SSE stream must never overwrite the
   * new ordering's results.
   */
  async *execute(
    id: string,
    body: {steps: Step[]; revision?: number; sample?: string; input?: JsonValue},
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const res = await fetch(`/api/pipelines/${id}/execute`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'accept': 'text/event-stream'},
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.json().catch(() => ({}));
      throw Object.assign(new Error(detail?.error ?? `execute failed: ${res.status}`), {
        status: res.status, body: detail,
      });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const line = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          yield JSON.parse(line.slice(6)) as StreamEvent;
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  node: async (
    executionId: string,
    afterStep: number,
    path: string,
  ): Promise<{state: 'missing'} | {state: 'value'; value: JsonValue; truncated: boolean}> => {
    const q = new URLSearchParams({afterStep: String(afterStep), path});
    return fetch(`/api/executions/${executionId}/nodes?${q}`).then(jsonOrThrow);
  },
};

export type {StepResult, StepFailurePayload};
