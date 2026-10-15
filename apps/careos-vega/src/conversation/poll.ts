import type {TurnEvent, TurnPage} from '../api/types';

export interface PollDeps {
  fetchEvents(turnId: string, after: number): Promise<TurnPage>;
  sleep(ms: number): Promise<void>;
}

export interface CancelFlag {
  cancelled: boolean;
}

const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Follows one turn by cursor long-poll until the server reports it done.
 * The cursor makes a retry idempotent: a failed request re-asks for the same `after`, so no event is lost or
 * repeated. Vega documents XHR and WebSocket but not streaming fetch/EventSource, hence polling.
 */
export async function followTurn(
  turnId: string,
  deps: PollDeps,
  onEvent: (e: TurnEvent) => void,
  flag: CancelFlag,
): Promise<void> {
  let after = 0;
  let failures = 0;
  while (!flag.cancelled) {
    let page: TurnPage;
    try {
      page = await deps.fetchEvents(turnId, after);
      failures = 0;
    } catch (e) {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        throw e;
      }
      await deps.sleep(500 * 2 ** failures);
      continue;
    }
    if (flag.cancelled) {
      return;
    }
    for (const e of page.events) {
      onEvent(e);
    }
    after = page.next;
    if (page.done) {
      return;
    }
    if (page.events.length === 0) {
      await deps.sleep(250); // guards against a hot loop if a server returns early with nothing
    }
  }
}
