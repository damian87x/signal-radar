import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Item, Result } from "../types.js";
import { run, type Runner } from "../exec.js";

/** How to invoke twitter-cli for `search`: a command plus argv prefix. */
export interface SearchVia {
  cmd: string;
  prefix: string[];
}

export interface FetchXOptions {
  queries: string[];
  max: number;
  runner?: Runner;
  /** Called for each source that failed while the run continues with the others. */
  onSkip?: (query: string, error: string) => void;
  /**
   * How to run `search`. Default: when no custom runner is given and twitter-cli's Python is
   * found, the bundled shims/twitter_x_home.py (workaround for twitter-cli#88); else `twitter`.
   * Pass null to force plain `twitter`.
   */
  searchVia?: SearchVia | null;
}

const SHIM = fileURLToPath(new URL("../../shims/twitter_x_home.py", import.meta.url));

/** Finds the Python interpreter twitter-cli is installed with (from the `twitter` shebang). */
export function resolveSearchVia(): SearchVia | null {
  if (!existsSync(SHIM)) return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const bin = join(dir, "twitter");
    if (!dir || !existsSync(bin)) continue;
    try {
      const first = readFileSync(bin, "utf8").split("\n", 1)[0] ?? "";
      const python = first.startsWith("#!") ? first.slice(2).trim().split(/\s+/)[0] : "";
      if (python && /python/.test(python) && existsSync(python)) return { cmd: python, prefix: [SHIM] };
    } catch {
      // unreadable launcher: fall back to plain `twitter`
    }
    return null;
  }
  return null;
}

// twitter-cli's stdout envelope (verified against twitter_cli/output.py, twitter-cli 0.8.5):
// success = {"ok":true,"schema_version":...,"data":[tweets]}
// error   = {"ok":false,"schema_version":...,"error":{"code":"not_authenticated"|..., "message":"...", "details"?}}
interface TwitterCliError {
  code?: unknown;
  message?: unknown;
}

interface TwitterCliEnvelope {
  ok: unknown;
  data?: unknown;
  error?: TwitterCliError;
}

// Narrow fallback for when stdout isn't a parseable envelope at all (e.g. a crash
// before twitter-cli can emit JSON). Structured error.code/message is preferred;
// this must not match free text loosely (a message containing "author" is not auth).
const AUTH_FALLBACK_PATTERN = /not_authenticated|HTTP 401|cookie/i;

interface TwitterCliTweet {
  id?: unknown;
  text?: unknown;
  author?: { screenName?: unknown };
  metrics?: {
    likes?: unknown;
    retweets?: unknown;
    replies?: unknown;
    quotes?: unknown;
    views?: unknown;
  };
  createdAtISO?: unknown;
  createdAt?: unknown;
}

function parseEnvelope(stdout: string): TwitterCliEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      return parsed as TwitterCliEnvelope;
    }
  } catch {
    // not JSON, or not an envelope
  }
  return undefined;
}

function isAuthError(error: TwitterCliError | undefined): boolean {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  return code === "not_authenticated" || /HTTP 401/i.test(message);
}

type Command = "feed" | "user-posts" | "list" | "search";

/** Picks the read-only twitter-cli command for a query string. */
function buildArgs(query: string, max: number): { command: Command; args: string[] } {
  if (query === "feed") {
    return { command: "feed", args: ["feed", "-n", String(max), "--json"] };
  }
  if (query.startsWith("@")) {
    const handle = query.slice(1);
    return { command: "user-posts", args: ["user-posts", handle, "-n", String(max), "--json"] };
  }
  if (query.startsWith("list:")) {
    const id = query.slice("list:".length);
    return { command: "list", args: ["list", id, "-n", String(max), "--json"] };
  }
  return {
    command: "search",
    args: ["search", query, "-t", "latest", "-n", String(max), "--json"],
  };
}

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function mapTweet(tweet: TwitterCliTweet, fetchedAt: string): Item | null {
  const id = typeof tweet.id === "string" ? tweet.id : String(tweet.id ?? "");
  if (!id) return null;
  const screenName = typeof tweet.author?.screenName === "string" ? tweet.author.screenName : "";
  const metrics = tweet.metrics ?? {};
  const createdAt =
    typeof tweet.createdAtISO === "string"
      ? tweet.createdAtISO
      : typeof tweet.createdAt === "string"
        ? tweet.createdAt
        : undefined;

  return {
    lane: "x",
    id,
    url: `https://x.com/${screenName}/status/${id}`,
    author: screenName,
    text: typeof tweet.text === "string" ? tweet.text : "",
    metrics: {
      likes: toNumber(metrics.likes),
      retweets: toNumber(metrics.retweets),
      replies: toNumber(metrics.replies),
      views: toNumber(metrics.views),
      quotes: toNumber(metrics.quotes),
    },
    createdAt,
    fetchedAt,
  };
}

/**
 * Fetches X posts for each query through a read-only twitter-cli command:
 * 'feed' -> home timeline, '@handle' -> user-posts, 'list:<id>' -> list, else -> search
 * (plain twitter-cli 0.8.5 search 404s, twitter-cli#88; search goes through shims/twitter_x_home.py
 * when available, and a remaining 404 is reported as x_search_unavailable).
 */
export async function fetchX(opts: FetchXOptions): Promise<Result<Item[]>> {
  const runner = opts.runner ?? run;
  // A caller-supplied runner (tests) gets plain `twitter` unless searchVia is given explicitly.
  const searchVia = opts.searchVia !== undefined ? opts.searchVia : opts.runner ? null : resolveSearchVia();
  const fetchedAt = new Date().toISOString();
  const items = new Map<string, Item>();
  const errors: string[] = [];

  for (const query of opts.queries) {
    const { command, args } = buildArgs(query, opts.max);
    const result =
      command === "search" && searchVia
        ? await runner(searchVia.cmd, [...searchVia.prefix, ...args])
        : await runner("twitter", args);

    const envelope = parseEnvelope(result.stdout);
    let error: string | null = null;

    // Trust a parsed ok:false envelope over the exit code, whatever it is.
    if (envelope && envelope.ok === false) {
      const code = typeof envelope.error?.code === "string" ? envelope.error.code : "unknown";
      if (isAuthError(envelope.error)) return { ok: false, error: "x_auth" };
      if (command === "search" && code === "not_found") error = "x_search_unavailable";
      else if (code === "rate_limited") error = "x_rate_limited";
      else error = `x_search_failed: ${code}`;
    } else if (result.code !== 0) {
      // stdout wasn't a parseable ok:false envelope; fall back to a narrow stderr check.
      if (AUTH_FALLBACK_PATTERN.test(result.stderr)) return { ok: false, error: "x_auth" };
      error = "x_search_failed";
    } else if (!envelope || envelope.ok !== true || !Array.isArray(envelope.data)) {
      error = "x_parse_failed";
    }

    // One bad source (e.g. a mistyped @handle) is skipped; the others still count.
    if (error) {
      errors.push(error);
      opts.onSkip?.(query, error);
      continue;
    }

    for (const tweet of (envelope as TwitterCliEnvelope).data as TwitterCliTweet[]) {
      const item = mapTweet(tweet, fetchedAt);
      if (item && !items.has(item.id)) {
        items.set(item.id, item);
      }
    }
  }

  if (errors.length > 0 && errors.length === opts.queries.length) {
    return { ok: false, error: errors[0] };
  }
  return { ok: true, value: [...items.values()] };
}
