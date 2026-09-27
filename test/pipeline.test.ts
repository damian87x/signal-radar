import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "../src/exec.ts";
import { runLane } from "../src/pipeline.ts";
import { createStore } from "../src/store.ts";
import type { Item } from "../src/types.ts";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const failAll: Runner = async () => ({ code: 1, stdout: "", stderr: "stub", timedOut: false });

function post(id: string, author: string, fetchedAt: string): Item {
  return { lane: "x", id, url: `https://x.com/${author}/status/${id}`, author, text: "a post", metrics: {}, fetchedAt };
}

describe("runLane creators", () => {
  it("draws on posts scored in the last 7 days, including delivered ones", async () => {
    const store = createStore(":memory:");
    store.upsert([post("1", "recent", "2026-09-26T12:00:00.000Z"), post("2", "stale", "2026-08-28T12:00:00.000Z")]);
    store.setScore("x", "1", null, 0.6);
    store.setScore("x", "2", null, 0.6);
    store.markDelivered("x", ["1", "2"], "2026-09-26T13:00:00.000Z");
    store.markDelivered("x", ["2"], "2026-08-28T13:00:00.000Z");

    const result = await runLane("creators", {
      store,
      runner: failAll,
      now: () => NOW,
      outDir: mkdtempSync(join(tmpdir(), "sr-pipeline-")),
      dry: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fetched).toBe(1);
    expect(store.unscored("creators", 10).map((i) => i.author)).toEqual(["recent"]);
  });
});
