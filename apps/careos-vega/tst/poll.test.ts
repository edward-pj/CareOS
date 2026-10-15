import {describe, expect, it} from 'vitest';
import type {TurnEvent, TurnPage} from '../src/api/types';
import {followTurn, type CancelFlag} from '../src/conversation/poll';

const ev = (seq: number, type: TurnEvent['type'] = 'assistant_delta'): TurnEvent =>
  ({seq, type, data: type === 'assistant_delta' ? {text: `m${seq}`} : {}}) as TurnEvent;
const noSleep = {sleep: async () => undefined};

describe('followTurn', () => {
  it('walks the cursor, delivers each event once, and stops at done', async () => {
    const asked: number[] = [];
    const pages: TurnPage[] = [
      {events: [ev(1, 'tool_call')], done: false, next: 1},
      {events: [ev(2), ev(3, 'done')], done: true, next: 3},
    ];
    const got: number[] = [];
    await followTurn(
      't',
      {...noSleep, fetchEvents: async (_id, after) => { asked.push(after); return pages.shift()!; }},
      (e) => got.push(e.seq),
      {cancelled: false},
    );
    expect(asked).toEqual([0, 1]);
    expect(got).toEqual([1, 2, 3]);
  });

  it('retries a failed request with the same cursor, so nothing is lost or repeated', async () => {
    const asked: number[] = [];
    let call = 0;
    const got: number[] = [];
    await followTurn(
      't',
      {
        ...noSleep,
        fetchEvents: async (_id, after) => {
          asked.push(after);
          call += 1;
          if (call === 2) { throw new Error('network'); }
          return call === 1
            ? {events: [ev(1)], done: false, next: 1}
            : {events: [ev(2, 'done')], done: true, next: 2};
        },
      },
      (e) => got.push(e.seq),
      {cancelled: false},
    );
    expect(asked).toEqual([0, 1, 1]);
    expect(got).toEqual([1, 2]);
  });

  it('gives up after three consecutive failures', async () => {
    let calls = 0;
    await expect(
      followTurn('t', {...noSleep, fetchEvents: async () => { calls += 1; throw new Error('down'); }}, () => undefined, {cancelled: false}),
    ).rejects.toThrow('down');
    expect(calls).toBe(3);
  });

  it('backs off exponentially between retries', async () => {
    const waits: number[] = [];
    await expect(
      followTurn('t', {sleep: async (ms) => { waits.push(ms); }, fetchEvents: async () => { throw new Error('x'); }}, () => undefined, {cancelled: false}),
    ).rejects.toThrow();
    expect(waits).toEqual([1000, 2000]);
  });

  it('stops delivering once cancelled, even if a request is in flight', async () => {
    const flag: CancelFlag = {cancelled: false};
    const got: number[] = [];
    await followTurn(
      't',
      {...noSleep, fetchEvents: async () => { flag.cancelled = true; return {events: [ev(1)], done: false, next: 1}; }},
      (e) => got.push(e.seq),
      flag,
    );
    expect(got).toEqual([]);
  });

  it('pauses briefly on an empty, not-done page instead of spinning', async () => {
    const waits: number[] = [];
    let n = 0;
    await followTurn(
      't',
      {
        sleep: async (ms) => { waits.push(ms); },
        fetchEvents: async () => (++n === 1 ? {events: [], done: false, next: 0} : {events: [ev(1, 'done')], done: true, next: 1}),
      },
      () => undefined,
      {cancelled: false},
    );
    expect(waits).toEqual([250]);
  });
});
