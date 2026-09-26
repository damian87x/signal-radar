import { run, type Runner } from "./exec.ts";
import type { Item, JevAnswers, JevQuestion, Result, Rubric } from "./types.ts";

const ASK_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 8;

/** Pipes {state, questions} to `jev ask` on stdin and parses the documented response shape. */
export async function askJev(
  state: string,
  questions: JevQuestion[],
  runner: Runner = run,
): Promise<Result<JevAnswers>> {
  let result;
  try {
    result = await runner("jev", ["ask"], {
      stdin: JSON.stringify({ state, questions }),
      timeoutMs: ASK_TIMEOUT_MS,
    });
  } catch (e) {
    return { ok: false, error: `runner threw: ${String(e)}` };
  }

  if (result.timedOut) {
    return { ok: false, error: "timeout" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: "unparseable stdout" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "unparseable stdout" };
  }

  if ("error" in parsed) {
    const body = parsed as { error: unknown };
    return { ok: false, error: String(body.error) };
  }

  if (result.code === 2) {
    return { ok: false, error: `exit 2: ${result.stdout}` };
  }

  if (result.code !== 0) {
    return { ok: false, error: `exit ${result.code}` };
  }

  const answers = (parsed as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) {
    return { ok: false, error: "unparseable stdout" };
  }

  return { ok: true, value: answers as JevAnswers };
}

export interface ScoredItem {
  item: Item;
  answers: JevAnswers | null;
  rank: number | null;
  error?: string;
}

/** Scores items through a rubric via `jev ask`, with bounded concurrency. Never throws. */
export async function scoreItems(
  items: Item[],
  rubric: Rubric,
  opts: { runner?: Runner; concurrency?: number } = {},
): Promise<ScoredItem[]> {
  const runner = opts.runner ?? run;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const results: ScoredItem[] = new Array(items.length);

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      const answer = await askJev(rubric.state(item), rubric.questions, runner);
      if (answer.ok) {
        try {
          results[i] = { item, answers: answer.value, rank: rubric.rank(answer.value, item) };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          results[i] = { item, answers: answer.value, rank: null, error: `rank_failed: ${message}` };
        }
      } else {
        results[i] = { item, answers: null, rank: null, error: answer.error };
      }
    }
  }

  const poolSize = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return results;
}
