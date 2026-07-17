/**
 * HTTP fetcher with rotating user-agents, throttling, retries.
 * Respectful scraping utilities used by all source scrapers.
 */

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0",
];

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export interface FetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  // mean delay between requests to same host — jitter is added on top
  minDelayMs?: number;
  maxDelayMs?: number;
  retries?: number;
}

// Per-host last-request timestamps to enforce throttling
const hostLastRequest: Map<string, number> = new Map();

async function throttle(host: string, minMs: number, maxMs: number): Promise<void> {
  const last = hostLastRequest.get(host) ?? 0;
  const now = Date.now();
  const elapsed = now - last;
  const target = minMs + Math.random() * Math.max(0, maxMs - minMs);
  if (elapsed < target) {
    const wait = target - elapsed;
    await new Promise((r) => setTimeout(r, wait));
  }
  hostLastRequest.set(host, Date.now());
}

export async function fetchWithRotation(
  url: string,
  opts: FetchOptions = {}
): Promise<Response> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 30000,
    minDelayMs = 800,
    maxDelayMs = 2200,
    retries = 3,
  } = opts;

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host, minDelayMs, maxDelayMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const ua = pickUserAgent();
      const finalHeaders: Record<string, string> = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        ...headers,
      };
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body,
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeout);
      if (res.status === 429 || res.status >= 500) {
        // backoff and retry
        const backoff = 2000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      const backoff = 1500 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr ?? new Error(`Failed to fetch ${url}`);
}

/**
 * Get text content from an HTML string given a simple regex pattern.
 * Useful for lightweight scraping without a full DOM parser in environments
 * where cheerio is unavailable.
 */
export function regexExtract(html: string, pattern: RegExp): string[] {
  const results: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  while ((m = re.exec(html)) !== null) {
    results.push(m[1] ?? m[0]);
  }
  return results;
}

/**
 * Very small HTML tag stripper — converts HTML to plain text.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
