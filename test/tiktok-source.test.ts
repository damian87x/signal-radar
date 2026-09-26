import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, Runner } from "../src/exec.ts";
import { fetchTikTok, parseCount } from "../src/sources/tiktok.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/tiktok-search.json"), "utf8"),
) as unknown[];

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

describe("parseCount", () => {
  it("parses millions", () => {
    expect(parseCount("1.2M")).toBe(1_200_000);
  });

  it("parses thousands", () => {
    expect(parseCount("45.6K")).toBe(45_600);
  });

  it("parses comma-separated plain numbers", () => {
    expect(parseCount("2,341")).toBe(2341);
  });

  it("parses bare digits", () => {
    expect(parseCount("523")).toBe(523);
  });
});

describe("fetchTikTok", () => {
  it("parses fixture cards into Items using only read-only opencli verbs", async () => {
    const calls: { args: string[] }[] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push({ args });
      expect(cmd).toBe("opencli");
      if (args.includes("open")) return ok("");
      if (args.includes("eval")) return ok(JSON.stringify(fixture));
      throw new Error(`unexpected opencli call: ${args.join(" ")}`);
    };

    const result = await fetchTikTok({ queries: ["pasta hack"], maxPerQuery: 10, runner });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.value.length).toBe(fixture.length);

    for (const item of result.value) {
      expect(item.lane).toBe("tiktok");
      expect(typeof item.id).toBe("string");
      expect(item.url).toMatch(/^https:\/\/www\.tiktok\.com\//);
      expect(typeof item.author).toBe("string");
      expect(item.author.length).toBeGreaterThan(0);
      expect(typeof item.text).toBe("string");
      expect(typeof item.metrics.views).toBe("number");
      expect(typeof item.metrics.likes).toBe("number");
      expect(typeof item.metrics.comments).toBe("number");
      expect(typeof item.metrics.shares).toBe("number");
    }

    const first = result.value[0];
    expect(first.id).toBe("7321098765432109876");
    expect(first.author).toBe("chef.mara");
    expect(first.metrics.views).toBe(1_200_000);
    expect(first.metrics.likes).toBe(184_300);
    expect(first.metrics.comments).toBe(2341);
    expect(first.metrics.shares).toBe(5_600);

    // Every opencli call must be browser <session> open|eval — never click/follow/like/comment actions.
    for (const call of calls) {
      expect(call.args[0]).toBe("browser");
      const verb = call.args[2];
      expect(["open", "eval"]).toContain(verb);
    }

    const openCall = calls.find((c) => c.args[2] === "open");
    expect(openCall?.args[3]).toMatch(/tiktok\.com/);
  });

  it("caps returned items at maxPerQuery", async () => {
    const runner: Runner = async (_cmd, args) => {
      if (args.includes("open")) return ok("");
      return ok(JSON.stringify(fixture));
    };

    const result = await fetchTikTok({ queries: ["pasta hack"], maxPerQuery: 1, runner });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.value.length).toBe(1);
  });

  it("returns ok:false when the runner reports a failure", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: "",
      stderr: "opencli: no bound Chrome session",
      timedOut: false,
    });

    const result = await fetchTikTok({ queries: ["pasta hack"], maxPerQuery: 10, runner });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.length).toBeGreaterThan(0);
  });
});
