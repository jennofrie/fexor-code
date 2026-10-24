/**
 * DeepSeek Search API adapter.
 *
 * The Anthropic server-side web_search tool is unavailable on third-party
 * endpoints. DeepSeek exposes a native Search API at /v1/tools/search using
 * the same bearer key as the Messages endpoint, so Fexor can offer real web
 * search on DeepSeek launchers without an extra provider key.
 */

export type DeepSeekSearchHit = {
  title: string;
  url: string;
  snippet?: string;
  summary?: string;
  siteName?: string | null;
  date?: string | null;
  rerankScore?: number;
  authority?: number;
};

export type DeepSeekSearchResponse = {
  hits: DeepSeekSearchHit[];
  cached: boolean;
  durationSeconds: number;
};

type DeepSeekSearchConfig = {
  baseUrl: string;
  apiKey: string;
};

type RawResult = Record<string, unknown>;

const DEFAULT_RESULT_COUNT = 8;
const MAX_RESULT_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CACHE_TTL_MS = 600_000;
const DEFAULT_CACHE_MAX = 100;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class NonRetryableSearchError extends Error {}

function readIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

/**
 * Detect a DeepSeek endpoint and return its search credentials. The DeepSeek
 * launcher sets ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic and
 * ANTHROPIC_AUTH_TOKEN, so no additional configuration is required.
 */
export function getDeepSeekSearchConfig(): DeepSeekSearchConfig | null {
  const explicitBase = process.env.DEEPSEEK_SEARCH_BASE_URL?.trim();
  const anthropicBase = process.env.ANTHROPIC_BASE_URL?.trim();
  const onDeepSeekEndpoint = (() => {
    if (explicitBase) {
      return true;
    }
    if (!anthropicBase) {
      return false;
    }
    try {
      const hostname = new URL(anthropicBase).hostname.toLowerCase();
      return (
        hostname === "api.deepseek.com" ||
        hostname.endsWith(".api.deepseek.com")
      );
    } catch {
      return /api\.deepseek\.com/i.test(anthropicBase);
    }
  })();

  if (!onDeepSeekEndpoint) {
    return null;
  }

  const apiKey =
    process.env.DEEPSEEK_API_KEY?.trim() ||
    process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    return null;
  }

  let baseUrl = explicitBase;
  if (!baseUrl && anthropicBase) {
    try {
      baseUrl = new URL(anthropicBase).origin;
    } catch {
      baseUrl = "https://api.deepseek.com";
    }
  }

  return {
    baseUrl: (baseUrl ?? "https://api.deepseek.com")
      .replace(/\/v1\/tools\/search\/?$/i, "")
      .replace(/\/+$/, ""),
    apiKey,
  };
}

type CacheEntry = {
  expiresAt: number;
  hits: DeepSeekSearchHit[];
};

const cache = new Map<string, CacheEntry>();

function cloneHits(hits: DeepSeekSearchHit[]): DeepSeekSearchHit[] {
  return hits.map((hit) => ({ ...hit }));
}

function cacheGet(key: string): DeepSeekSearchHit[] | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh insertion order for LRU eviction.
  cache.delete(key);
  cache.set(key, entry);
  return cloneHits(entry.hits);
}

function cacheSet(key: string, hits: DeepSeekSearchHit[]): void {
  const ttl = readIntEnv(
    "FEXOR_SEARCH_CACHE_TTL_MS",
    DEFAULT_CACHE_TTL_MS,
    0,
    86_400_000
  );
  if (ttl === 0) {
    return;
  }
  const max = readIntEnv("FEXOR_SEARCH_CACHE_MAX", DEFAULT_CACHE_MAX, 1, 1000);
  cache.set(key, { expiresAt: Date.now() + ttl, hits: cloneHits(hits) });
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

function normalizeDomain(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      ?.replace(/^\.+|\.+$/g, "") ?? ""
  );
}

function hostMatches(hostname: string, domain: string): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return false;
  }
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function buildQuery(
  query: string,
  allowedDomains?: string[],
  blockedDomains?: string[]
): string {
  const filters = [
    ...(allowedDomains ?? [])
      .slice(0, 2)
      .map((domain) => `site:${normalizeDomain(domain)}`)
      .filter((filter) => filter !== "site:"),
    ...(blockedDomains ?? [])
      .slice(0, 2)
      .map((domain) => `-site:${normalizeDomain(domain)}`)
      .filter((filter) => filter !== "-site:"),
  ];
  const withFilters = [query.trim(), ...filters].join(" ").trim();
  // DeepSeek rejects queries longer than 128 characters. Fall back to local
  // filtering when the domain operators would exceed that limit.
  return withFilters.length <= 128 ? withFilters : query.trim().slice(0, 128);
}

function applyDomainFilters(
  hits: DeepSeekSearchHit[],
  allowedDomains?: string[],
  blockedDomains?: string[]
): DeepSeekSearchHit[] {
  const allowed = (allowedDomains ?? []).map(normalizeDomain).filter(Boolean);
  const blocked = (blockedDomains ?? []).map(normalizeDomain).filter(Boolean);

  return hits.filter((hit) => {
    let hostname: string;
    try {
      hostname = new URL(hit.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (
      allowed.length > 0 &&
      !allowed.some((domain) => hostMatches(hostname, domain))
    ) {
      return false;
    }
    if (blocked.some((domain) => hostMatches(hostname, domain))) {
      return false;
    }
    return true;
  });
}

function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|spm$)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function dedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch {
    return url;
  }
}

function dedupeAndRank(
  hits: DeepSeekSearchHit[],
  limit: number
): DeepSeekSearchHit[] {
  const seen = new Set<string>();
  const unique = hits.filter((hit) => {
    const key = dedupeKey(hit.url);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  unique.sort(
    (a, b) =>
      (b.rerankScore ?? 0) - (a.rerankScore ?? 0) ||
      (b.authority ?? -1) - (a.authority ?? -1) ||
      (b.date ?? "").localeCompare(a.date ?? "")
  );

  return unique.slice(0, limit);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseHit(raw: RawResult): DeepSeekSearchHit | null {
  const title = asString(raw.title);
  const url = asString(raw.url);
  if (!title || !url) {
    return null;
  }
  return {
    title,
    url: canonicalizeUrl(url),
    snippet: asString(raw.snippet),
    summary: asString(raw.summary),
    siteName: asString(raw.site_name) ?? null,
    date: asString(raw.date) ?? null,
    rerankScore: asNumber(raw.rerank_score),
    authority: asNumber(raw.authority),
  };
}

function extractErrorMessage(parsed: unknown, fallback: string): string {
  if (typeof parsed === "object" && parsed !== null) {
    const error = (parsed as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
    const message = (parsed as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return fallback;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("DeepSeek search aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("DeepSeek search aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      parent.addEventListener("abort", abortFromParent, { once: true });
    }
  }
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`DeepSeek search timed out after ${timeoutMs}ms`)
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function requestSearch(
  config: DeepSeekSearchConfig,
  body: { query: string; count: number; need_content: boolean },
  signal: AbortSignal
): Promise<RawResult[]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${config.baseUrl}/v1/tools/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const message = extractErrorMessage(
          parsed,
          response.statusText || "request failed"
        );
        const detail = `DeepSeek search failed (HTTP ${response.status}): ${message}`;
        if (RETRYABLE_STATUS.has(response.status)) {
          lastError = new Error(detail);
          const retryAfter = Number(response.headers.get("retry-after"));
          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(5000, retryAfter * 1000)
              : Math.min(4000, 500 * 2 ** attempt);
          await sleep(delay, signal);
          continue;
        }
        throw new NonRetryableSearchError(detail);
      }

      const results = (parsed as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) {
        throw new NonRetryableSearchError(
          "DeepSeek search returned an invalid response (missing results array)"
        );
      }

      return results.filter(
        (item): item is RawResult => typeof item === "object" && item !== null
      );
    } catch (error) {
      if (error instanceof NonRetryableSearchError) {
        throw error;
      }
      if (signal.aborted) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      lastError = normalized;
      if (attempt < 2) {
        await sleep(Math.min(4000, 500 * 2 ** attempt), signal);
      }
    }
  }

  throw lastError ?? new Error("DeepSeek search failed");
}

export async function searchDeepSeek(params: {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  count?: number;
  needContent?: boolean;
  signal?: AbortSignal;
}): Promise<DeepSeekSearchResponse> {
  const config = getDeepSeekSearchConfig();
  if (!config) {
    throw new Error("DeepSeek search is not configured");
  }

  const count = Math.min(
    MAX_RESULT_COUNT,
    Math.max(
      1,
      params.count ??
        readIntEnv(
          "FEXOR_SEARCH_RESULT_COUNT",
          DEFAULT_RESULT_COUNT,
          1,
          MAX_RESULT_COUNT
        )
    )
  );
  const cacheKey = JSON.stringify({
    query: params.query.trim(),
    allowed: params.allowedDomains ?? [],
    blocked: params.blockedDomains ?? [],
    count,
  });

  const cached = cacheGet(cacheKey);
  if (cached) {
    return { hits: cached, cached: true, durationSeconds: 0 };
  }

  const started = performance.now();
  const timeoutMs = readIntEnv(
    "FEXOR_SEARCH_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
    1000,
    120_000
  );
  const { signal, cleanup } = createTimeoutSignal(params.signal, timeoutMs);

  try {
    const rawResults = await requestSearch(
      config,
      {
        query: buildQuery(
          params.query,
          params.allowedDomains,
          params.blockedDomains
        ),
        count,
        need_content: params.needContent === true,
      },
      signal
    );

    const parsed = rawResults
      .map(parseHit)
      .filter((hit): hit is DeepSeekSearchHit => hit !== null);
    const filtered = applyDomainFilters(
      parsed,
      params.allowedDomains,
      params.blockedDomains
    );
    const hits = dedupeAndRank(filtered, count);
    cacheSet(cacheKey, hits);

    return {
      hits,
      cached: false,
      durationSeconds: (performance.now() - started) / 1000,
    };
  } finally {
    cleanup();
  }
}
