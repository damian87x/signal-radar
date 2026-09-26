import { run, type Runner } from "../exec.ts";
import type { Item, Result } from "../types.ts";

/** opencli browser session name reused across calls in a run. */
const SESSION = "signal-radar-tiktok";

/** Cap on how many search/hashtag pages (queries) a single run will open. */
const MAX_PAGES_PER_RUN = 20;

export interface FetchTikTokOptions {
  /** Search terms; a query starting with "#" is read as a hashtag page. */
  queries: string[];
  maxPerQuery: number;
  runner?: Runner;
  /** Called for a query that yielded nothing, so an empty run is never silent. */
  onSkip?: (query: string, error: string) => void;
}

/**
 * Asks opencli whether its Chrome session is logged in to TikTok. Returns false only when
 * opencli explicitly says so; any other outcome (old opencli, parse error) is "unknown" -> null.
 */
async function tiktokLoggedIn(runner: Runner): Promise<boolean | null> {
  const r = await runner("opencli", ["auth", "status", "--site", "tiktok", "-f", "json"]);
  if (r.code !== 0) return null;
  try {
    const rows: unknown = JSON.parse(r.stdout);
    const row = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>).find((x) => x?.site === "tiktok") : null;
    return typeof row?.logged_in === "boolean" ? row.logged_in : null;
  } catch {
    return null;
  }
}

interface RawCard {
  id?: unknown;
  url?: unknown;
  author?: unknown;
  caption?: unknown;
  views?: unknown;
  likes?: unknown;
  comments?: unknown;
  shares?: unknown;
}

/** Video card containers. `search_top-item` is what tiktok.com/search renders (checked live 2026-09-26). */
const CARD_SELECTOR = '[data-e2e="search_top-item"], [data-e2e="search_video-item"], [data-e2e="challenge-item"]';

/**
 * JS run in-page via `opencli browser <session> eval`. Read-only: no click/follow/like/comment.
 * On search pages the card holds the link + view count and a sibling block holds caption and
 * author, so text fields are looked up in the nearest ancestor that contains a caption.
 * Search cards show views only; likes/comments/shares stay empty there.
 */
const EXTRACT_JS = `Array.from(document.querySelectorAll('${CARD_SELECTOR}')).map((el) => {
  const link = el.querySelector('a[href*="/video/"]');
  const href = link ? link.href : "";
  let box = el;
  for (let i = 0; i < 4 && box.parentElement && !box.querySelector('[data-e2e="search-card-video-caption"], [data-e2e="video-desc"]'); i++) box = box.parentElement;
  const text = (sel) => ((el.querySelector(sel) || box.querySelector(sel))?.textContent ?? "").trim();
  const idMatch = href.match(/\\/video\\/(\\d+)/);
  const authorMatch = href.match(/\\/@([^/]+)\\//);
  return {
    id: idMatch ? idMatch[1] : "",
    url: href,
    author: authorMatch ? authorMatch[1] : text('[data-e2e="search-card-user-unique-id"]'),
    caption: text('[data-e2e="search-card-video-caption"], [data-e2e="video-desc"]'),
    views: text('[data-e2e="video-views"], [data-e2e="video-views-count"], strong[data-e2e$="views-count"]'),
    likes: text('[data-e2e="video-like-count"], strong[data-e2e$="like-count"]'),
    comments: text('[data-e2e="video-comment-count"], strong[data-e2e$="comment-count"]'),
    shares: text('[data-e2e="video-share-count"], strong[data-e2e$="share-count"]'),
  };
}).filter((card) => card.id);`;

/** Parses metric strings like "1.2M", "45.6K" or "2,341" into a number. */
export function parseCount(raw: string): number {
  const cleaned = raw.trim().replace(/,/g, "");
  const match = cleaned.match(/^([\d.]+)\s*([KkMmBb]?)$/);
  if (!match) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  const value = parseFloat(match[1]);
  const multipliers: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  const multiplier = multipliers[match[2].toLowerCase()] ?? 1;
  return Math.round(value * multiplier);
}

function urlForQuery(query: string): string {
  // Hashtags go through search too: /tag/<name> pages rendered no videos for a logged-in
  // session (2026-09-26), while search?q=%23<name> rendered 14 cards.
  return `https://www.tiktok.com/search?q=${encodeURIComponent(query.trim())}`;
}

function parseCards(stdout: string): RawCard[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { result?: unknown }).result)
      ? (parsed as { result: unknown[] }).result
      : [];
  return list.filter((c): c is RawCard => typeof c === "object" && c !== null);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * TikTok video ids carry their creation time: the upper 32 bits are Unix seconds. Search cards
 * show no date, so this is the only age signal for momentum. Returns undefined for anything
 * that doesn't decode to a plausible date (2016 .. fetch time + 1 day).
 */
export function createdAtFromId(id: string, fetchedAt: string): string | undefined {
  if (!/^\d{15,20}$/.test(id)) return undefined;
  const ms = Number(BigInt(id) >> 32n) * 1000;
  const latest = Date.parse(fetchedAt) + 86_400_000;
  if (ms < Date.parse("2016-01-01T00:00:00Z") || !(ms <= latest)) return undefined;
  return new Date(ms).toISOString();
}

function toItem(card: RawCard, fetchedAt: string): Item | null {
  const id = asString(card.id);
  if (!id) return null;
  return {
    createdAt: createdAtFromId(id, fetchedAt),
    lane: "tiktok",
    id,
    url: asString(card.url) || `https://www.tiktok.com/video/${id}`,
    author: asString(card.author),
    text: asString(card.caption),
    metrics: {
      views: parseCount(asString(card.views)),
      likes: parseCount(asString(card.likes)),
      comments: parseCount(asString(card.comments)),
      shares: parseCount(asString(card.shares)),
    },
    fetchedAt,
  };
}

/** Reads TikTok search/hashtag pages via opencli's logged-in Chrome session. Read-only. */
export async function fetchTikTok(options: FetchTikTokOptions): Promise<Result<Item[]>> {
  const { queries, maxPerQuery, runner = run } = options;
  const cappedQueries = queries.slice(0, MAX_PAGES_PER_RUN);
  const items: Item[] = [];
  const fetchedAt = new Date().toISOString();

  if ((await tiktokLoggedIn(runner)) === false) {
    return {
      ok: false,
      error: "tiktok_auth: opencli's Chrome is not logged in to TikTok (check: opencli auth status --site tiktok)",
    };
  }

  for (const query of cappedQueries) {
    const url = urlForQuery(query);

    const openResult = await runner("opencli", ["browser", SESSION, "open", url]);
    if (openResult.code !== 0) {
      return {
        ok: false,
        error: `opencli browser open failed for "${query}": ${openResult.stderr || openResult.stdout}`,
      };
    }

    // Cards render after page load. A timeout here is fine: extraction then finds no cards and
    // the query is reported as tiktok_no_results.
    await runner("opencli", ["browser", SESSION, "wait", "selector", CARD_SELECTOR, "--timeout", "15000"]);

    const evalResult = await runner("opencli", ["browser", SESSION, "eval", EXTRACT_JS]);
    if (evalResult.code !== 0) {
      return {
        ok: false,
        error: `opencli browser eval failed for "${query}": ${evalResult.stderr || evalResult.stdout}`,
      };
    }

    let cards: RawCard[];
    try {
      cards = parseCards(evalResult.stdout);
    } catch (e) {
      return { ok: false, error: `failed to parse opencli output for "${query}": ${String(e)}` };
    }

    const before = items.length;
    for (const card of cards.slice(0, maxPerQuery)) {
      const item = toItem(card, fetchedAt);
      if (item) items.push(item);
    }
    if (items.length === before) options.onSkip?.(query, "tiktok_no_results");
  }

  return { ok: true, value: items };
}
