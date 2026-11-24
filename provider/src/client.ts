/** Minimal GitHub REST client: injected fetch, user access token, JSON in and out. */
import { KeyholdError } from 'keyhold/util';

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GitHubClientOptions {
  fetch: FetchFn;
  token: string;
  apiBase?: string;
  userAgent?: string;
  /** How to wait between retries (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
  /** Retries for 5xx answers and, on writes, for a lost reply. Default 2. */
  retries?: number;
  now?: () => number;
}

/**
 * A rate-limit error: code `too_many_attempts`, plus how long GitHub asked us to wait.
 * Primary limit (403/429 with x-ratelimit-remaining 0), secondary limit (403/429 with
 * retry-after, or a "secondary rate limit" message) and plain 429 all end up here.
 */
export class RateLimitError extends KeyholdError {
  constructor(
    message: string,
    /** Seconds GitHub asked us to wait (retry-after, or until x-ratelimit-reset). */
    readonly retryAfter: number,
  ) {
    super('too_many_attempts', message);
  }
}

/** Seconds to wait before trying again, when `e` is a GitHub rate limit; else undefined. */
export const retryAfterOf = (e: unknown): number | undefined => (e instanceof RateLimitError ? e.retryAfter : undefined);

/** fetch() rejecting (offline, connection reset, or a reply lost after the server acted). */
export const isNetworkError = (e: unknown) => e instanceof TypeError;

export class GitHubClient {
  readonly base: string;
  /** Requests made, for rate-limit budgeting and tests. */
  requests = 0;
  /** Until when (ms since epoch) GitHub asked us to hold off; 0 when not rate-limited. */
  rateLimitedUntil = 0;
  private sleep: (ms: number) => Promise<void>;
  private retries: number;
  private now: () => number;
  constructor(private o: GitHubClientOptions) {
    this.base = (o.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retries = o.retries ?? 2;
    this.now = o.now ?? Date.now;
  }

  /** Small growing pause before retry `attempt` (0-based). */
  backoff(attempt: number) {
    return this.sleep(250 * 3 ** attempt);
  }

  /**
   * One request. 5xx answers are retried a few times. With `retryNetwork` (only for writes the
   * caller makes safe to repeat), a rejected fetch is retried too: the write may have landed, so
   * the caller must accept "already done" on the retry.
   */
  async call(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json', retryNetwork = false): Promise<{ status: number; data: any }> {
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      let res: Awaited<ReturnType<FetchFn>>;
      try {
        res = await this.o.fetch(this.base + path, {
          method,
          headers: {
            Accept: accept,
            Authorization: `Bearer ${this.o.token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(this.o.userAgent ? { 'User-Agent': this.o.userAgent } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        if (retryNetwork && isNetworkError(e) && attempt < this.retries) {
          await this.backoff(attempt);
          continue;
        }
        throw e;
      }
      if (res.status === 401) throw new KeyholdError('auth_failed', 'GitHub token is not valid');
      const text = await res.text();
      let data: any = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (res.status === 403 || res.status === 429) {
        const wait = this.rateLimit(res.status, res.headers, data);
        if (wait !== undefined) {
          this.rateLimitedUntil = this.now() + wait * 1000;
          throw new RateLimitError(`GitHub rate limit reached; try again in ${wait}s`, wait);
        }
      }
      if (res.status >= 500 && attempt < this.retries) {
        await this.backoff(attempt);
        continue;
      }
      return { status: res.status, data };
    }
  }

  /** Seconds to wait when this 403/429 is a rate limit (primary or secondary); else undefined. */
  private rateLimit(status: number, h: { get(name: string): string | null }, data: any): number | undefined {
    const retryAfter = Number(h.get('retry-after'));
    const remaining = h.get('x-ratelimit-remaining');
    const message = typeof data === 'object' && data ? String(data.message ?? '') : String(data ?? '');
    const limited = status === 429 || remaining === '0' || h.get('retry-after') !== null || /rate limit|abuse detection/i.test(message);
    if (!limited) return undefined;
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
    const reset = Number(h.get('x-ratelimit-reset'));
    if (remaining === '0' && Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - this.now() / 1000));
    // GitHub's advice for a secondary limit without retry-after: wait at least a minute.
    return 60;
  }

  /** Throws for anything outside `ok`. */
  async expect(method: string, path: string, ok: number[], body?: unknown) {
    const r = await this.call(method, path, body);
    if (!ok.includes(r.status)) {
      const code = r.status === 403 ? 'forbidden' : r.status === 404 ? 'not_found' : r.status === 409 || r.status === 422 ? 'conflict' : 'config';
      throw new KeyholdError(code, `GitHub ${method} ${path} -> ${r.status} ${typeof r.data === 'object' ? r.data?.message ?? '' : ''}`);
    }
    return r;
  }
}
