import type { Item, Result } from "../types.js";
import { run, type Runner } from "../exec.js";

export interface FetchXOptions {
  queries: string[];
  max: number;
  runner?: Runner;
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
 * (search 404s upstream as of twitter-cli 0.8.5; that failure is reported as x_search_unavailable).
 */
export async function fetchX(opts: FetchXOptions): Promise<Result<Item[]>> {
  const runner = opts.runner ?? run;
  const fetchedAt = new Date().toISOString();
  const items = new Map<string, Item>();

  for (const query of opts.queries) {
    const { command, args } = buildArgs(query, opts.max);
    const result = await runner("twitter", args);

    const envelope = parseEnvelope(result.stdout);

    // Trust a parsed ok:false envelope over the exit code, whatever it is.
    if (envelope && envelope.ok === false) {
      const code = typeof envelope.error?.code === "string" ? envelope.error.code : "unknown";
      if (isAuthError(envelope.error)) {
        return { ok: false, error: "x_auth" };
      }
      if (command === "search" && code === "not_found") {
        return { ok: false, error: "x_search_unavailable" };
      }
      return { ok: false, error: `x_search_failed: ${code}` };
    }

    if (result.code !== 0) {
      // stdout wasn't a parseable ok:false envelope; fall back to a narrow stderr check.
      if (AUTH_FALLBACK_PATTERN.test(result.stderr)) {
        return { ok: false, error: "x_auth" };
      }
      return { ok: false, error: "x_search_failed" };
    }

    if (!envelope || envelope.ok !== true || !Array.isArray(envelope.data)) {
      return { ok: false, error: "x_parse_failed" };
    }

    for (const tweet of envelope.data as TwitterCliTweet[]) {
      const item = mapTweet(tweet, fetchedAt);
      if (item && !items.has(item.id)) {
        items.set(item.id, item);
      }
    }
  }

  return { ok: true, value: [...items.values()] };
}
