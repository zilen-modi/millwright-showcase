import type {
  BoardState, CostState, PrInboxState, PrReviewDetail, PrReviewsState, RunLog, TicketDetail, JsonRecord,
} from './types';

/** A non-2xx response from the panel API, carrying the server's own readable fields.
 *  `reason` is set only by the ship gate (contract §3): a 409 that explains WHY a run
 *  was refused, which the UI surfaces verbatim instead of a generic failure. */
export class ApiError extends Error {
  readonly status: number;
  readonly reason: string | null;
  readonly key: string | null;
  readonly issues: string[] | null;

  constructor(status: number, body: JsonRecord) {
    const message = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = typeof body.reason === 'string' ? body.reason : null;
    this.key = typeof body.key === 'string' ? body.key : null;
    this.issues = Array.isArray(body.issues) ? (body.issues as string[]) : null;
  }

  /** True when this is the rubric-receipt ship gate rather than an ordinary conflict. */
  get isShipGate() {
    return this.status === 409 && this.reason !== null;
  }
}

async function parse(res: Response): Promise<JsonRecord> {
  try {
    return (await res.json()) as JsonRecord;
  } catch {
    return {};
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(res.status, await parse(res));
  return (await res.json()) as T;
}

export async function postJson<T = JsonRecord>(path: string, body: JsonRecord): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await parse(res);
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

export const api = {
  state: (signal?: AbortSignal) => getJson<BoardState>('/api/state', signal),
  cost: (signal?: AbortSignal) => getJson<CostState>('/api/cost', signal),
  config: (signal?: AbortSignal) => getJson<{ config: JsonRecord }>('/api/config', signal),
  prReviews: (signal?: AbortSignal) => getJson<PrReviewsState>('/api/pr-reviews', signal),
  prInbox: (signal?: AbortSignal) => getJson<PrInboxState>('/api/pr-inbox', signal),
  prReview: (ref: string, signal?: AbortSignal) =>
    getJson<PrReviewDetail>(`/api/pr-review?ref=${encodeURIComponent(ref)}`, signal),
  ticket: (key: string, signal?: AbortSignal) =>
    getJson<TicketDetail>(`/api/ticket?key=${encodeURIComponent(key)}`, signal),
  log: (key: string, signal?: AbortSignal) =>
    getJson<RunLog>(`/api/log?key=${encodeURIComponent(key)}`, signal),
};

/** Accept a bare key or any string containing one (e.g. a Jira URL). The server
 *  re-validates against its own strict KEY_RE — this is only a UX affordance. */
export function parseTicketKey(raw: string): string | null {
  const m = String(raw || '').match(/PROJ-\d+/i);
  return m ? m[0].toUpperCase() : null;
}
