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
/** How many recent undelivered posts per source lane feed the creators lane. */
const CREATOR_SOURCE_LIMIT = 200;

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
}

interface FetchedLane {
  items: Item[];
  rubric: Rubric;
}

async function fetchLane(lane: Lane, deps: RunLaneDeps): Promise<Result<FetchedLane>> {
  switch (lane) {
    case "x": {
      const result = await fetchX({ queries: deps.queries ?? [], max: 50, runner: deps.runner });
      if (!result.ok) return result;
      return { ok: true, value: { items: result.value, rubric: xAiRubric } };
    }
    case "tiktok": {
      const result = await fetchTikTok({
        queries: deps.queries ?? [],
        maxPerQuery: 50,
        runner: deps.runner,
      });
      if (!result.ok) return result;
      return { ok: true, value: { items: result.value, rubric: tiktokProductRubric } };
    }
    case "creators": {
      const candidates = creatorsFrom([
        ...deps.store.undelivered("x", CREATOR_SOURCE_LIMIT),
        ...deps.store.undelivered("tiktok", CREATOR_SOURCE_LIMIT),
      ]);
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

  const fetchResult = await fetchLane(lane, deps);
  if (!fetchResult.ok) return fetchResult;
  const { items, rubric } = fetchResult.value;

  const inserted = store.upsert(items);

  const unscoredItems = store.unscored(lane, UNSCORED_LIMIT);
  const scoreResults = await scoreItems(unscoredItems, rubric, { runner });
  let scored = 0;
  for (const r of scoreResults) {
    store.setScore(lane, r.item.id, r.answers, r.rank);
    if (r.rank !== null) scored++;
  }

  const topScored = store.undelivered(lane, enrichTop);
  let enriched = 0;
  for (const s of topScored) {
    if (s.rank === null || s.rank < rubric.threshold || s.enrich !== null) continue;
    const result = await enrich(s.item, rubric, { runner });
    if (result.ok) {
      store.setEnrich(lane, s.item.id, result.value);
      enriched++;
    }
  }

  const date = deps.now().toISOString().slice(0, 10);
  const sectionItems = store.undelivered(lane, enrichTop);
  await writeDigest(deps.outDir, date, [{ lane, items: sectionItems }]);

  let delivered = 0;
  if (!dry) {
    const nowIso = deps.now().toISOString();
    const outboxDir = join(deps.outDir, "outbox");
    delivered = await deliver(store, lane, {
      limit: enrichTop,
      now: nowIso,
      render: (topItems) => renderMarkdown(date, [{ lane, items: topItems }]),
      send: async (md) => {
        await mkdir(outboxDir, { recursive: true });
        const fileName = `${nowIso.replace(/:/g, "-")}-${lane}.md`;
        await writeFile(join(outboxDir, fileName), md, "utf8");
      },
    });
  }

  return { ok: true, value: { fetched: items.length, inserted, scored, enriched, delivered } };
}
