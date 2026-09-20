// Preview sessions. A preview executes a pipeline against a sample and keeps
// every intermediate state on the SERVER side. The stream yields one bounded
// summary event per step; the browser expands a node on demand through
// getNode(), which returns the full subtree for exactly one path.

import {applyStep, StepError} from '../shared/engine';
import {getValue} from '../shared/path';
import {
  DoneStreamEvent,
  ErrorStreamEvent,
  StepStreamEvent,
  summarize,
} from '../shared/summary';
import {JsonValue, Step} from '../shared/types';

export type PreviewEvent =
  | {type: 'start'; sessionId: string; totalSteps: number}
  | StepStreamEvent
  | DoneStreamEvent
  | ErrorStreamEvent;

export interface SessionState {
  /** Original input; expands a pre-state summary when a failure hits step 0. */
  input: JsonValue;
  /** states[i] = document after step i. */
  states: JsonValue[];
  finalOutput: JsonValue | null;
  failedIndex: number | null;
  createdAt: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 50;

export class PreviewManager {
  private sessions = new Map<string, SessionState>();
  private idCounter = 0;

  createId(): string {
    this.idCounter += 1;
    return `pv_${Date.now().toString(36)}_${this.idCounter}`;
  }

  store(sessionId: string, state: SessionState): void {
    this.prune();
    this.sessions.set(sessionId, state);
  }

  get(sessionId: string): SessionState | undefined {
    const session = this.sessions.get(sessionId);
    if (session && Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  /** Full subtree at one path of one state.
   *  stepIndex: -1 = input, i = state after step i, N = final output. */
  getNode(sessionId: string, stepIndex: number, path: string): JsonValue | undefined {
    const session = this.get(sessionId);
    if (!session) return undefined;
    const state = this.stateAt(session, stepIndex);
    if (!state) return undefined;
    const lookup = getValue(state, path);
    return lookup.found ? lookup.value : undefined;
  }

  private stateAt(session: SessionState, stepIndex: number): JsonValue | undefined {
    if (stepIndex === -1) return session.input;
    if (stepIndex >= 0 && stepIndex < session.states.length) {
      return session.states[stepIndex];
    }
    if (stepIndex === session.states.length && session.failedIndex === null) {
      return session.finalOutput ?? undefined;
    }
    return undefined;
  }

  private prune(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    const oldest = [...this.sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) this.sessions.delete(oldest[0]);
  }
}

function touchedBy(step: Step): {sources: string[]; targets: string[]} {
  switch (step.op) {
    case 'rename':
    case 'move':
      return {sources: [step.source], targets: [step.target]};
    case 'split':
      return {sources: [step.source], targets: [...step.targets]};
    case 'merge':
      return {sources: [...step.sources], targets: [step.target]};
    case 'expression':
      return {
        sources: Object.values(step.inputs ?? {}),
        targets: [step.mapEach ? `${step.mapEach}[*].${step.target}` : step.target],
      };
  }
}

/** Run a preview, invoking `onEvent` for each event. Intermediate states are
 *  retained in the returned SessionState (server side); only summaries cross
 *  the wire. */
export async function runPreview(
  manager: PreviewManager,
  input: JsonValue,
  steps: Step[],
  options: {onEvent: (event: PreviewEvent) => void; delayMs?: number; signal?: {aborted: boolean}} = {
    onEvent: () => {},
  }
): Promise<void> {
  const sessionId = manager.createId();
  options.onEvent({type: 'start', sessionId, totalSteps: steps.length});

  const states: JsonValue[] = [];
  const cloneJson = (value: JsonValue): JsonValue =>
    typeof structuredClone === 'function'
      ? structuredClone(value)
      : (JSON.parse(JSON.stringify(value)) as JsonValue);
  const inputClone = cloneJson(input);
  let state: JsonValue = cloneJson(input);

  for (let index = 0; index < steps.length; index += 1) {
    if (options.signal?.aborted) return;
    const step = steps[index];
    const preState = state;
    // Atomicity barrier: the step runs on a clone. A mid-step exception
    // discards every partial mutation; `preState` stays the authoritative
    // state and is never presented as output.
    const candidate: JsonValue = cloneJson(state);
    try {
      applyStep(candidate, step);
    } catch (error) {
      const failure = error as StepError;
      const event: ErrorStreamEvent = {
        type: 'error',
        failedIndex: index,
        stepId: step.id,
        code: failure.code ?? 'invalid_step',
        message: failure.message ?? 'step failed',
        sourcePath: failure.sourcePath ?? null,
        preStateSummary: summarize(preState),
        preStateStepIndex: index - 1,
      };
      manager.store(sessionId, {input: inputClone, states, finalOutput: null, failedIndex: index, createdAt: Date.now()});
      options.onEvent(event);
      return;
    }
    state = candidate;
    const event: StepStreamEvent = {
      type: 'step',
      index,
      stepId: step.id,
      op: step.op,
      changed: touchedBy(step),
      summary: summarize(state),
    };
    options.onEvent(event);
    // Store the post-state AFTER the summary was produced, never the input.
    states.push(state);
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  manager.store(sessionId, {input: inputClone, states, finalOutput: state, failedIndex: null, createdAt: Date.now()});
  options.onEvent({type: 'done', outputSummary: summarize(state)});
}
