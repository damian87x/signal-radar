// Creator (influencer) lane: aggregate authors already scored by other lanes, rank
// their fit, and enrich x creators with public profile counts. Read-only everywhere:
// nothing here sends, follows, DMs or emails anyone.
import type { Item, Scored } from "../types.ts";
import { run, type Runner } from "../exec.ts";

export interface CreatorsFromOptions {
  minPosts?: number;
}

interface CreatorGroup {
  sourceLane: string;
  handle: string;
  posts: number;
  rankSum: number;
  totalLikes: number;
  totalViews: number;
  rankedTexts: { rank: number; text: string }[];
}

function profileUrl(sourceLane: string, handle: string): string {
  if (sourceLane === "tiktok") return `https://www.tiktok.com/@${handle}`;
  return `https://x.com/${handle}`;
}

/** Aggregates scored posts by (sourceLane, handle) into creator profile candidates. */
export function creatorsFrom(scored: Scored[], options: CreatorsFromOptions = {}): Item[] {
  const minPosts = options.minPosts ?? 1;
  const groups = new Map<string, CreatorGroup>();

  for (const s of scored) {
    if (s.rank === null) continue;
    const { item, rank } = s;
    if (!item.author) continue;
    const key = `${item.lane}:${item.author}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        sourceLane: item.lane,
        handle: item.author,
        posts: 0,
        rankSum: 0,
        totalLikes: 0,
        totalViews: 0,
        rankedTexts: [],
      };
      groups.set(key, group);
    }
    group.posts += 1;
    group.rankSum += rank;
    group.totalLikes += item.metrics.likes ?? 0;
    group.totalViews += item.metrics.views ?? 0;
    group.rankedTexts.push({ rank, text: item.text });
  }

  const fetchedAt = new Date().toISOString();
  const result: Item[] = [];

  for (const group of groups.values()) {
    if (group.posts < minPosts) continue;
    const text = [...group.rankedTexts]
      .sort((a, b) => b.rank - a.rank)
      .map((t) => t.text)
      .join("\n\n");

    result.push({
      lane: "creators",
      id: `${group.sourceLane}:${group.handle}`,
      url: profileUrl(group.sourceLane, group.handle),
      author: group.handle,
      text,
      metrics: {
        posts: group.posts,
        avgRank: group.rankSum / group.posts,
        totalLikes: group.totalLikes,
        totalViews: group.totalViews,
      },
      fetchedAt,
    });
  }

  return result;
}

interface TwitterUserPayload {
  ok?: unknown;
  data?: { followers?: unknown; following?: unknown };
}

function isXCreator(item: Item): boolean {
  return item.lane === "creators" && item.id.startsWith("x:");
}

/**
 * Adds followers/following counts to x creators via the read-only `twitter user` command.
 * TikTok creators pass through untouched. Any failure (non-zero exit, bad JSON, missing
 * fields) leaves the item unchanged.
 */
export async function enrichXProfile(items: Item[], runner: Runner = run): Promise<Item[]> {
  const result: Item[] = [];

  for (const item of items) {
    if (!isXCreator(item)) {
      result.push(item);
      continue;
    }

    const exec = await runner("twitter", ["user", item.author, "--json"]);
    if (exec.code !== 0) {
      result.push(item);
      continue;
    }

    let parsed: TwitterUserPayload;
    try {
      parsed = JSON.parse(exec.stdout) as TwitterUserPayload;
    } catch {
      result.push(item);
      continue;
    }

    if (parsed.ok !== true || !parsed.data) {
      result.push(item);
      continue;
    }

    const followers = Number(parsed.data.followers);
    const following = Number(parsed.data.following);
    if (!Number.isFinite(followers) || !Number.isFinite(following)) {
      result.push(item);
      continue;
    }

    result.push({ ...item, metrics: { ...item.metrics, followers, following } });
  }

  return result;
}
