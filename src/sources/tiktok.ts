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

/** JS run in-page via `opencli browser <session> eval`. Read-only: no click/follow/like/comment. */
const EXTRACT_JS = `Array.from(document.querySelectorAll('[data-e2e="search_video-item"], [data-e2e="challenge-item"]')).map((el) => {
  const link = el.querySelector('a[href*="/video/"]');
  const href = link ? link.href : "";
  const idMatch = href.match(/\\/video\\/(\\d+)/);
  const authorMatch = href.match(/\\/@([^/]+)\\//);
  return {
    id: idMatch ? idMatch[1] : "",
    url: href,
    author: authorMatch ? authorMatch[1] : "",
    caption: el.querySelector('[data-e2e="search-card-video-caption"], [data-e2e="video-desc"]')?.textContent ?? "",
    views: el.querySelector('[data-e2e="video-views-count"], strong[data-e2e$="views-count"]')?.textContent ?? "",
    likes: el.querySelector('[data-e2e="video-like-count"], strong[data-e2e$="like-count"]')?.textContent ?? "",
    comments: el.querySelector('[data-e2e="video-comment-count"], strong[data-e2e$="comment-count"]')?.textContent ?? "",
    shares: el.querySelector('[data-e2e="video-share-count"], strong[data-e2e$="share-count"]')?.textContent ?? "",
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
  const trimmed = query.trim();
  if (trimmed.startsWith("#")) {
    return `https://www.tiktok.com/tag/${encodeURIComponent(trimmed.slice(1))}`;
  }
  return `https://www.tiktok.com/search?q=${encodeURIComponent(trimmed)}`;
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

function toItem(card: RawCard, fetchedAt: string): Item | null {
  const id = asString(card.id);
  if (!id) return null;
  return {
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

  for (const query of cappedQueries) {
    const url = urlForQuery(query);

    const openResult = await runner("opencli", ["browser", SESSION, "open", url]);
    if (openResult.code !== 0) {
      return {
        ok: false,
        error: `opencli browser open failed for "${query}": ${openResult.stderr || openResult.stdout}`,
      };
    }

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

    for (const card of cards.slice(0, maxPerQuery)) {
      const item = toItem(card, fetchedAt);
      if (item) items.push(item);
    }
  }

  return { ok: true, value: items };
}
