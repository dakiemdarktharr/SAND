import type { RunEvent } from '../shared';
export interface TimelineState { cursor: number; events: RunEvent[] }
/** At-least-once REST consumption. A gap never advances the committed UI cursor. */
export function applyReplay(previous: TimelineState, runId: string, incoming: RunEvent[]): TimelineState {
  let cursor = previous.cursor;
  const events = [...previous.events];
  const sequenceIds = new Map(events.map(event => [event.sequence, event.id]));
  const idSequences = new Map(events.map(event => [event.id, event.sequence]));
  for (const event of [...incoming].sort((a, b) => a.sequence - b.sequence)) {
    if (event.runId !== runId || event.schemaVersion !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error('Unsupported or cross-run event. The replay cursor has not advanced.');
    if (event.sequence <= cursor) {
      if (sequenceIds.get(event.sequence) !== event.id) throw new Error('An event identity changed. The replay cursor has not advanced.');
      continue;
    }
    if (event.sequence !== cursor + 1) throw new Error('Timeline gap detected. Reconnect to replay from the last verified cursor.');
    if (idSequences.has(event.id)) throw new Error('An event ID was reused at a different sequence. Replay stopped.');
    if (events.length >= 5000) throw new Error('This preview displays at most 5,000 timeline events. Use the control-plane event or audit export API for larger histories.');
    events.push(event); sequenceIds.set(event.sequence, event.id); idSequences.set(event.id, event.sequence); cursor = event.sequence;
  }
  return { cursor, events };
}

