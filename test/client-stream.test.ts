import {afterEach, describe, expect, it, vi} from 'vitest';
import {streamPreview} from '../src/client/api';
import type {JsonValue, Step} from '../src/shared/types';

interface Handle {
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  signal: AbortSignal | null;
  aborted: boolean;
}

function installFetchMock(streams: Handle[]) {
  vi.stubGlobal(
    'fetch',
    (_url: string, init?: RequestInit) =>
      new Promise((resolve) => {
        const handle: Handle = {controller: null, signal: init?.signal ?? null, aborted: false};
        init?.signal?.addEventListener('abort', () => {
          handle.aborted = true;
        });
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            handle.controller = controller;
          },
        });
        streams.push(handle);
        resolve({ok: true, body});
      })
  );
}

const encoder = new TextEncoder();
const startEvent = (sessionId: string) => JSON.stringify({type: 'start', sessionId, totalSteps: 1}) + '\n';
const stepEvent = (id: string) =>
  JSON.stringify({
    type: 'step',
    index: 0,
    stepId: id,
    op: 'rename',
    changed: {sources: [], targets: []},
    summary: {kind: 'object', size: 0},
  }) + '\n';
const doneEvent = () => JSON.stringify({type: 'done', outputSummary: {kind: 'object', size: 0}}) + '\n';

describe('streamPreview generation guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('aborts and silences an older preview once a newer step order is run', async () => {
    const handles: Handle[] = [];
    installFetchMock(handles);

    const sample: JsonValue = {};
    const step: Step = {id: 'A', op: 'rename', source: '$.a', target: '$.b'};
    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];

    const a = streamPreview(sample, [{...step, target: '$.from-a'}], (event) => eventsA.push(event));
    await Promise.resolve();
    await Promise.resolve();
    expect(handles.length).toBe(1);

    const b = streamPreview(sample, [{...step, id: 'B', target: '$.from-b'}], (event) => eventsB.push(event));
    await Promise.resolve();
    await Promise.resolve();

    // The old request was aborted at the network layer.
    const handleA = handles[0];
    expect(handleA.aborted).toBe(true);
    expect(a.generation).toBeLessThan(b.generation);

    // Old stream may still deliver buffered start, but never its step/done.
    handleA.controller?.enqueue(encoder.encode(startEvent('sess-a') + stepEvent('A') + doneEvent()));
    handleA.controller?.close();

    // New stream delivers everything.
    const handleB = handles[1];
    handleB.controller?.enqueue(encoder.encode(startEvent('sess-b') + stepEvent('B') + doneEvent()));
    handleB.controller?.close();

    await b.done;

    expect(eventsA).toEqual([]);
    expect(eventsB.map((event) => (event as {type: string}).type)).toEqual(['start', 'step', 'done']);
  });
});
