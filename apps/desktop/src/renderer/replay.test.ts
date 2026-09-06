import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../shared';
import { applyReplay } from './replay';
const event = (sequence: number, overrides: Partial<RunEvent> = {}): RunEvent => ({ id: 'event-' + sequence, runId: 'run-a', sequence, schemaVersion: 1, type: 'step.progress', at: '2026-09-07T00:00:00Z', payload: {}, ...overrides });
describe('persisted timeline client consumption', () => {
  it('deduplicates and orders repeated batches through many reconnects', () => {
    let state = applyReplay({ cursor: 0, events: [] }, 'run-a', [event(3), event(1), event(2), event(2)]);
    for (let reconnect = 0; reconnect < 12; reconnect++) state = applyReplay(state, 'run-a', [event(3), event(2), event(4)]);
    expect(state.cursor).toBe(4); expect(state.events.map(e => e.id)).toEqual(['event-1', 'event-2', 'event-3', 'event-4']);
  });
  it('does not advance on network gaps and recovers from complete replay', () => {
    const state = applyReplay({ cursor: 0, events: [] }, 'run-a', [event(1)]);
    expect(() => applyReplay(state, 'run-a', [event(3)])).toThrow('gap'); expect(state.cursor).toBe(1);
    expect(applyReplay(state, 'run-a', [event(2), event(3)]).cursor).toBe(3);
  });
  it('rejects reused identity, incompatible schema and another run', () => {
    const state = applyReplay({ cursor: 0, events: [] }, 'run-a', [event(1)]);
    expect(() => applyReplay(state, 'run-a', [event(1, { id: 'forged' })])).toThrow('identity');
    expect(() => applyReplay(state, 'run-a', [event(2, { id: 'event-1' })])).toThrow('reused');
    expect(() => applyReplay(state, 'run-a', [event(2, { schemaVersion: 2 })])).toThrow('Unsupported');
    expect(() => applyReplay(state, 'run-a', [event(2, { runId: 'run-b' })])).toThrow('cross-run');
  });
  it('fails visibly at the memory bound instead of silently dropping events', () => {
    const events = Array.from({ length: 5000 }, (_, index) => event(index + 1));
    expect(() => applyReplay({ cursor: 5000, events }, 'run-a', [event(5001)])).toThrow('5,000');
  });
});

