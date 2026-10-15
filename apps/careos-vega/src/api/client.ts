import {LONG_POLL_WAIT_S, REQUEST_TIMEOUT_MS, SERVER_URL} from '../config';
import type {ConverseRequest, StateResponse, TurnPage} from './types';

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

// Vega documents XMLHttpRequest and WebSocket; streaming fetch / EventSource are not documented,
// so this client sticks to XHR. Conversation turns are read by cursor long-poll (see conversation/poll.ts).
function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `${SERVER_URL}${path}`);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader('accept', 'application/json');
    if (body !== undefined) {
      xhr.setRequestHeader('content-type', 'application/json');
    }
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(`${method} ${path} failed (${xhr.status})`, xhr.status));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as T);
      } catch {
        reject(new ApiError(`${method} ${path} returned invalid JSON`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError(`Cannot reach CareOS server at ${SERVER_URL}`));
    xhr.ontimeout = () => reject(new ApiError(`${method} ${path} timed out`));
    xhr.send(body === undefined ? undefined : JSON.stringify(body));
  });
}

export const api = {
  getState: () => request<StateResponse>('GET', '/api/state'),
  resetDemo: () => request<{ok: true}>('POST', '/api/demo/reset', {}),
  converse: (body: ConverseRequest) => request<{turn_id: string}>('POST', '/api/converse', body),
  /** Cursor long-poll: the server holds the request up to `waitS` seconds for new events. */
  getTurnEvents: (turnId: string, after: number, waitS = LONG_POLL_WAIT_S) =>
    request<TurnPage>('GET', `/api/turns/${turnId}/events?after=${after}&wait=${waitS}`, undefined, (waitS + 10) * 1000),
};
