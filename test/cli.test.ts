import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";
import { createStore } from "../src/store.ts";
import type { Runner } from "../src/exec.ts";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "x-search.json",
);
const xSearchFixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

const TOP_TWEET_TEXT =
  "Shipped a new AI agent that reads your calendar and drafts the follow-up emails before you even ask. Not hype, just saved me 40 minutes today.";

const NOW = () => new Date("2026-09-24T12:00:00.000Z");

/** Stub Runner: serves the x-search fixture for twitter, canned jev answers keyed off the
 * tweet text embedded in the jev ask state, and a canned grok envelope for enrich. */
function makeRunner(): Runner {
  return async (cmd, _args, opts) => {
    if (cmd === "twitter") {
      return { code: 0, stdout: JSON.stringify(xSearchFixture), stderr: "", timedOut: false };
    }
    if (cmd === "jev") {
      const parsed = JSON.parse(opts?.stdin ?? "{}") as { state?: string };
      const state = parsed.state ?? "";
      let answers;
      if (state.includes("Shipped a new AI agent")) {
        // substantive, novel, no bait -> highest rank
        answers = {
          substantive: { type: "noul", noul: 1 },
          novelty: { type: "score", score: 2, probabilities: {}, confidence: 1, legend: {} },
          kind: { type: "choice", choice: "tool", probabilities: {}, confidence: 1 },
          bait: { type: "noul", noul: 0 },
        };
      } else if (state.includes("LFG!!!")) {
        // pure hype/bait -> lowest rank
        answers = {
          substantive: { type: "noul", noul: 0 },
          novelty: { type: "score", score: 0, probabilities: {}, confidence: 1, legend: {} },
          kind: { type: "choice", choice: "opinion", probabilities: {}, confidence: 1 },
          bait: { type: "noul", noul: 1 },
        };
      } else {
        // moderately substantive -> mid rank, below the enrich threshold
        answers = {
          substantive: { type: "noul", noul: 0.6 },
          novelty: { type: "score", score: 1, probabilities: {}, confidence: 1, legend: {} },
          kind: { type: "choice", choice: "research", probabilities: {}, confidence: 1 },
          bait: { type: "noul", noul: 0 },
        };
      }
      return { code: 0, stdout: JSON.stringify({ answers }), stderr: "", timedOut: false };
    }
    if (cmd === "grok") {
      return {
        code: 0,
        stdout: JSON.stringify({
          type: "result",
          structuredOutput: { why: "canned reason", tags: ["ai"] },
        }),
        stderr: "",
        timedOut: false,
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected cmd: ${cmd}`, timedOut: false };
  };
}

/** Stub Runner: twitter search always fails with a not_authenticated envelope. */
function makeAuthFailingRunner(): Runner {
  return async (cmd) => {
    if (cmd === "twitter") {
      return {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          schema_version: "1",
          error: { code: "not_authenticated", message: "Cookie expired (HTTP 401)." },
        }),
        stderr: "",
        timedOut: false,
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected cmd: ${cmd}`, timedOut: false };
  };
}

function tmpOutDir(): string {
  return mkdtempSync(path.join(tmpdir(), "signal-radar-cli-test-"));
}

/** Wraps a Runner to count invocations of a given command. */
function countCalls(base: Runner, cmd: string): { runner: Runner; count: () => number } {
  let n = 0;
  const runner: Runner = async (c, args, opts) => {
    if (c === cmd) n++;
    return base(c, args, opts);
  };
  return { runner, count: () => n };
}

describe("cli main", () => {
  it("'run --lane x --dry' writes <out>/<date>.html with the top fixture tweet and delivers nothing", async () => {
    const outDir = tmpOutDir();
    const store = createStore(":memory:");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(
      ["run", "--lane", "x", "--dry", "--out", outDir, "--queries", "ai agents"],
      { store, runner: makeRunner(), now: NOW },
    );

    expect(code).toBe(0);

    const htmlPath = path.join(outDir, "2026-09-24.html");
    expect(existsSync(htmlPath)).toBe(true);
    expect(readFileSync(htmlPath, "utf-8")).toContain(TOP_TWEET_TEXT);

    const counts = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(counts).toEqual({ fetched: 3, inserted: 3, scored: 3, enriched: 1, delivered: 0, skipped: [] });

    expect(existsSync(path.join(outDir, "outbox"))).toBe(false);

    logSpy.mockRestore();
    store.close();
  });

  it("a second dry run over the same undelivered items makes 0 grok calls", async () => {
    const outDir = tmpOutDir();
    const store = createStore(":memory:");
    const { runner, count } = countCalls(makeRunner(), "grok");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const argv = ["run", "--lane", "x", "--dry", "--out", outDir, "--queries", "ai agents"];

    const firstCode = await main(argv, { store, runner, now: NOW });
    expect(firstCode).toBe(0);
    expect(count()).toBe(1);

    const secondCode = await main(argv, { store, runner, now: NOW });
    expect(secondCode).toBe(0);
    expect(count()).toBe(1);

    expect(existsSync(path.join(outDir, "outbox"))).toBe(false);

    logSpy.mockRestore();
    store.close();
  });

  it("a non-dry run writes exactly one outbox file, and a second run adds none", async () => {
    const outDir = tmpOutDir();
    const store = createStore(":memory:");
    const runner = makeRunner();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const argv = ["run", "--lane", "x", "--out", outDir, "--queries", "ai agents"];

    const firstCode = await main(argv, { store, runner, now: NOW });
    expect(firstCode).toBe(0);

    const outboxDir = path.join(outDir, "outbox");
    const filesAfterFirst = readdirSync(outboxDir);
    expect(filesAfterFirst).toHaveLength(1);
    expect(filesAfterFirst[0]).toBe("2026-09-24T12-00-00.000Z-x.md");

    const secondCode = await main(argv, { store, runner, now: NOW });
    expect(secondCode).toBe(0);

    const filesAfterSecond = readdirSync(outboxDir);
    expect(filesAfterSecond).toHaveLength(1);

    logSpy.mockRestore();
    store.close();
  });

  it("a non-dry run marks items delivered, and a second run delivers 0", async () => {
    const outDir = tmpOutDir();
    const store = createStore(":memory:");
    const runner = makeRunner();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const argv = ["run", "--lane", "x", "--out", outDir, "--queries", "ai agents"];

    const firstCode = await main(argv, { store, runner, now: NOW });
    expect(firstCode).toBe(0);
    const firstCounts = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(firstCounts).toEqual({ fetched: 3, inserted: 3, scored: 3, enriched: 1, delivered: 3, skipped: [] });

    logSpy.mockClear();

    const secondCode = await main(argv, { store, runner, now: NOW });
    expect(secondCode).toBe(0);
    const secondCounts = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(secondCounts).toEqual({ fetched: 3, inserted: 0, scored: 0, enriched: 0, delivered: 0, skipped: [] });

    logSpy.mockRestore();
    store.close();
  });

  it("an x_auth failure returns 1 without writing a digest", async () => {
    const outDir = tmpOutDir();
    const store = createStore(":memory:");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await main(
      ["run", "--lane", "x", "--out", outDir, "--queries", "ai agents"],
      { store, runner: makeAuthFailingRunner(), now: NOW },
    );

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith("x_auth");
    expect(existsSync(path.join(outDir, "2026-09-24.html"))).toBe(false);

    errSpy.mockRestore();
    store.close();
  });
});

describe("cli short form: signal-radar <lane> [sources...]", () => {
  function recordingRunner(calls: string[][]): Runner {
    const base = makeRunner();
    return async (cmd, args, opts) => {
      if (cmd === "twitter") calls.push(args);
      return base(cmd, args, opts);
    };
  }

  it("'x' with no sources reads the home feed and writes into --home", async () => {
    const home = tmpOutDir();
    const store = createStore(":memory:");
    const calls: string[][] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["x", "--dry", "--home", home], {
      store,
      runner: recordingRunner(calls),
      now: NOW,
    });

    expect(code).toBe(0);
    expect(calls[0]?.[0]).toBe("feed");
    expect(existsSync(path.join(home, "2026-09-24.html"))).toBe(true);
    expect(logSpy.mock.calls[0]?.[0]).toContain("3 fetched");
    logSpy.mockRestore();
    store.close();
  });

  it("positional sources become queries and --top caps enrichment", async () => {
    const home = tmpOutDir();
    const store = createStore(":memory:");
    const calls: string[][] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(
      ["x", "@karpathy", "list:42", "--top", "1", "--dry", "--json", "--home", home],
      { store, runner: recordingRunner(calls), now: NOW },
    );

    expect(code).toBe(0);
    expect(calls.map((a) => a[0])).toEqual(["user-posts", "list"]);
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string).enriched).toBeLessThanOrEqual(1);
    logSpy.mockRestore();
    store.close();
  });

  it("rejects no lane, an unknown lane, tiktok without terms, and mail without a file", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main([])).toBe(1);
    expect(await main(["nope"])).toBe(1);
    expect(await main(["tiktok"])).toBe(1);
    expect(await main(["mail"])).toBe(1);
    errSpy.mockRestore();
  });
});

describe("scoped delivery and cumulative digest", () => {
  it("'x @mine' never delivers backlog posts fetched earlier for '@other'", async () => {
    const home = tmpOutDir();
    const store = createStore(":memory:");
    const base = makeRunner();
    const otherFixture = {
      ...xSearchFixture,
      data: xSearchFixture.data.map((t: { id: string }) => ({ ...t, id: `9${t.id}` })),
    };
    const runner: Runner = async (cmd, args, opts) => {
      if (cmd === "twitter" && args[1] === "other") {
        return { code: 0, stdout: JSON.stringify(otherFixture), stderr: "", timedOut: false };
      }
      return base(cmd, args, opts);
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await main(["x", "@other", "--dry", "--home", home], { store, runner, now: NOW })).toBe(0);
    expect(await main(["x", "@mine", "--home", home], { store, runner, now: NOW })).toBe(0);

    const outbox = readdirSync(path.join(home, "outbox"));
    expect(outbox).toHaveLength(1);
    const md = readFileSync(path.join(home, "outbox", outbox[0]!), "utf-8");
    for (const t of otherFixture.data) expect(md).not.toContain(`/status/${t.id}`);
    expect(md).toContain(`/status/${xSearchFixture.data[0].id}`);
    logSpy.mockRestore();
    store.close();
  });

  it("<date>.html keeps every lane seen today, not just the last run", async () => {
    const home = tmpOutDir();
    const store = createStore(":memory:");
    store.upsert([
      {
        lane: "tiktok",
        id: "tt1",
        url: "https://www.tiktok.com/@shop/video/1",
        author: "shop",
        text: "TIKTOK_EARLIER_TODAY gadget demo",
        metrics: {},
        fetchedAt: "2026-09-24T01:00:00.000Z",
      },
    ]);
    store.setScore("tiktok", "tt1", null, 0.9);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await main(["x", "--dry", "--home", home], { store, runner: makeRunner(), now: NOW })).toBe(0);

    const html = readFileSync(path.join(home, "2026-09-24.html"), "utf-8");
    expect(html).toContain("TIKTOK_EARLIER_TODAY");
    expect(html).toContain(TOP_TWEET_TEXT);
    logSpy.mockRestore();
    store.close();
  });
});
