// Pipeline runner: fetch -> store -> jev score -> grok enrich top N -> digest -> deliver.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item, Lane, Result, Rubric, Store } from "./types.ts";
import type { Runner } from "./exec.ts";
import { fetchX } from "./sources/x.ts";
import { fetchTikTok } from "./sources/tiktok.ts";
import { creatorsFrom, enrichXProfile } from "./sources/creators.ts";
import { loadMailExport, sortMail, mailLeadRubric, type MailItem } from "./sources/gmail.ts";
import { xAiRubric } from "./rubrics/x-ai.ts";
import { tiktokProductRubric } from "./rubrics/tiktok-product.ts";
import { creatorsRubric } from "./rubrics/creators.ts";
import { scoreItems } from "./jev.ts";
import { enrich } from "./grok.ts";
import { writeDigest, renderMarkdown } from "./digest.ts";
import { deliver } from "./deliver.ts";

/** Cap on unscored items pulled from the store in a single run. */
const UNSCORED_LIMIT = 500;
/** How many recent scored posts per source lane feed the creators lane. */
const CREATOR_SOURCE_LIMIT = 200;
/** Posts fetched or delivered within this many days feed the creators lane, delivered or not. */
const CREATOR_WINDOW_DAYS = 7;

export interface RunLaneDeps {
  store: Store;
  runner: Runner;
  now: () => Date;
  outDir: string;
  queries?: string[];
  mailFile?: string;
  enrichTop?: number;
  dry?: boolean;
}

export interface RunLaneCounts {
  fetched: number;
  inserted: number;
  scored: number;
  enriched: number;
  delivered: number;
  /** Sources that failed while others succeeded, as "<source>: <error>". */
  skipped: string[];
}

/** Items per lane shown in the cumulative daily digest. */
const DIGEST_PER_LANE = 25;

interface FetchedLane {
  items: Item[];
  rubric: Rubric;
}

async function fetchLane(lane: Lane, deps: RunLaneDeps, skipped: string[]): Promise<Result<FetchedLane>> {
  const onSkip = (source: string, error: string) => skipped.push(`${source}: ${error}`);
  switch (lane) {
    case "x": {
      const result = await fetchX({ queries: deps.queries ?? [], max: 50, runner: deps.runner, onSkip });
      if (!result.ok) return result;
      return { ok: true, value: { items: result.value, rubric: xAiRubric } };
    }
    case "tiktok": {
      const result = await fetchTikTok({
        queries: deps.queries ?? [],
        maxPerQuery: 50,
        runner: deps.runner,
        onSkip,
      });
      if (!result.ok) return result;
      return { ok: true, value: { items: result.value, rubric: tiktokProductRubric } };
    }
    case "creators": {
      const since = new Date(deps.now().getTime() - CREATOR_WINDOW_DAYS * 86_400_000).toISOString();
      const candidates = creatorsFrom(
        deps.store
          .since(since, CREATOR_SOURCE_LIMIT)
          .filter((s) => s.item.lane === "x" || s.item.lane === "tiktok"),
      );
      const items = await enrichXProfile(candidates, deps.runner);
      return { ok: true, value: { items, rubric: creatorsRubric } };
    }
    case "mail": {
      if (!deps.mailFile) return { ok: false, error: "mail lane requires mailFile" };
      let mailItems: MailItem[];
      try {
        mailItems = loadMailExport(deps.mailFile);
      } catch (e) {
        return {
          ok: false,
          error: `mail_load_failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const summaryResult = await sortMail(mailItems, deps.runner, { summary: true });
      if (!summaryResult.ok) return { ok: false, error: summaryResult.error };
      return { ok: true, value: { items: mailItems, rubric: mailLeadRubric } };
    }
  }
}

/** Runs one lane end to end: fetch, store, score, enrich the top items, digest, and deliver. */
export async function runLane(lane: Lane, deps: RunLaneDeps): Promise<Result<RunLaneCounts>> {
  const enrichTop = deps.enrichTop ?? 10;
  const dry = deps.dry ?? false;
  const { store, runner } = deps;

  const skipped: string[] = [];
  const fetchResult = await fetchLane(lane, deps, skipped);
  if (!fetchResult.ok) return fetchResult;
  const { items, rubric } = fetchResult.value;
  // Enrichment and delivery only consider what this run fetched, so `x @a` never
  // delivers a backlog post from @b.
  const fetchedIds = new Set(items.map((i) => i.id));

  const inserted = store.upsert(items);

  const unscoredItems = store.unscored(lane, UNSCORED_LIMIT);
  const scoreResults = await scoreItems(unscoredItems, rubric, { runner });
  let scored = 0;
  for (const r of scoreResults) {
    store.setScore(lane, r.item.id, r.answers, r.rank);
    if (r.rank !== null) scored++;
  }

  const topScored = store
    .undelivered(lane, UNSCORED_LIMIT)
    .filter((s) => fetchedIds.has(s.item.id))
    .slice(0, enrichTop);
  let enriched = 0;
  for (const s of topScored) {
    if (s.rank === null || s.rank < rubric.threshold || s.enrich !== null) continue;
    const result = await enrich(s.item, rubric, { runner });
    if (result.ok) {
      store.setEnrich(lane, s.item.id, result.value);
      enriched++;
    }
  }

  let delivered = 0;
  const date = deps.now().toISOString().slice(0, 10);
  if (!dry) {
    const nowIso = deps.now().toISOString();
    const outboxDir = join(deps.outDir, "outbox");
    delivered = await deliver(store, lane, {
      limit: enrichTop,
      ids: fetchedIds,
      now: nowIso,
      render: (topItems) => renderMarkdown(date, [{ lane, items: topItems }]),
      send: async (md) => {
        await mkdir(outboxDir, { recursive: true });
        const fileName = `${nowIso.replace(/:/g, "-")}-${lane}.md`;
        await writeFile(join(outboxDir, fileName), md, "utf8");
      },
    });
  }

  // Cumulative daily digest: every lane's items seen or delivered today, not just this run.
  const today = store.since(`${date}T00:00:00.000Z`, DIGEST_PER_LANE);
  const lanes: Lane[] = ["x", "tiktok", "creators", "mail"];
  const sections = lanes
    .map((l) => ({ lane: l, items: today.filter((s) => s.item.lane === l) }))
    .filter((s) => s.items.length > 0);
  await writeDigest(deps.outDir, date, sections);

  return { ok: true, value: { fetched: items.length, inserted, scored, enriched, delivered, skipped } };
}
