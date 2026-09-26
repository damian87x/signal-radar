import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Runner } from "../src/exec.js";
import { fetchX } from "../src/sources/x.js";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "x-search.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
  data: Array<{
    id: string;
    text: string;
    author: { screenName: string };
    metrics: { likes: number; retweets: number; replies: number; quotes: number; views: number };
    createdAtISO: string;
  }>;
};
const tweets = fixture.data;

describe("fetchX", () => {
  it("maps twitter-cli search JSON to Item[] and runs the read-only search command per query", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify(fixture), stderr: "", timedOut: false };
    };

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(calls).toEqual([
      { cmd: "twitter", args: ["search", "ai agents", "-t", "latest", "-n", "10", "--json"] },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value).toHaveLength(tweets.length);
    const first = result.value[0];
    const rawFirst = tweets[0];
    expect(first.lane).toBe("x");
    expect(first.id).toBe(rawFirst.id);
    expect(first.url).toBe(`https://x.com/${rawFirst.author.screenName}/status/${rawFirst.id}`);
    expect(first.author).toBe(rawFirst.author.screenName);
    expect(first.text).toBe(rawFirst.text);
    expect(first.metrics).toEqual({
      likes: rawFirst.metrics.likes,
      retweets: rawFirst.metrics.retweets,
      replies: rawFirst.metrics.replies,
      views: rawFirst.metrics.views,
      quotes: rawFirst.metrics.quotes,
    });
    expect(first.createdAt).toBe(rawFirst.createdAtISO);
    expect(typeof first.fetchedAt).toBe("string");
    expect(new Date(first.fetchedAt).toString()).not.toBe("Invalid Date");
  });

  it("dedupes items by id across queries and issues exact argv per query", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      const query = args[1];
      const subset = query === "first query" ? [tweets[0], tweets[1]] : [tweets[1], tweets[2]];
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, schema_version: "1", data: subset }),
        stderr: "",
        timedOut: false,
      };
    };

    const result = await fetchX({
      queries: ["first query", "second query"],
      max: 5,
      runner,
    });

    expect(calls).toEqual([
      { cmd: "twitter", args: ["search", "first query", "-t", "latest", "-n", "5", "--json"] },
      { cmd: "twitter", args: ["search", "second query", "-t", "latest", "-n", "5", "--json"] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    const ids = result.value.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([tweets[0].id, tweets[1].id, tweets[2].id].sort());
  });

  it("returns ok:false error 'x_auth' on an ok:false envelope with error.code 'not_authenticated'", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        schema_version: "1",
        error: {
          code: "not_authenticated",
          message:
            "Cookie expired or invalid (HTTP 401). Please re-login to x.com in your browser.",
        },
      }),
      stderr: "",
      timedOut: false,
    });

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(result).toEqual({ ok: false, error: "x_auth" });
  });

  it("classifies an ok:false envelope as x_auth when code is 'not_authenticated' even without 401 in the message", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        schema_version: "1",
        error: { code: "not_authenticated", message: "Please log in again." },
      }),
      stderr: "",
      timedOut: false,
    });

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(result).toEqual({ ok: false, error: "x_auth" });
  });

  it("classifies an ok:false envelope as x_auth when the message reports HTTP 401 under a different code", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        schema_version: "1",
        error: { code: "request_failed", message: "Upstream request failed (HTTP 401)." },
      }),
      stderr: "",
      timedOut: false,
    });

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(result).toEqual({ ok: false, error: "x_auth" });
  });

  it("classifies an ok:false envelope as x_auth regardless of exit code", async () => {
    const runner: Runner = async () => ({
      code: 0,
      stdout: JSON.stringify({
        ok: false,
        schema_version: "1",
        error: { code: "not_authenticated", message: "Cookies missing." },
      }),
      stderr: "",
      timedOut: false,
    });

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(result).toEqual({ ok: false, error: "x_auth" });
  });

  it("does not classify a message containing 'author' as x_auth, and reports the error code", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        schema_version: "1",
        error: {
          code: "internal_error",
          message: "Could not resolve the author of this thread.",
        },
      }),
      stderr: "",
      timedOut: false,
    });

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(result).toEqual({ ok: false, error: "x_search_failed: internal_error" });
  });

  it("maps other error codes to 'x_search_failed: <code>'", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        schema_version: "1",
        error: { code: "server_error", message: "Internal error." },
      }),
      stderr: "",
      timedOut: false,
    });

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(result).toEqual({ ok: false, error: "x_search_failed: server_error" });
  });

  it("maps rate_limited to x_rate_limited", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: JSON.stringify({ ok: false, schema_version: "1", error: { code: "rate_limited", message: "Too many requests." } }),
      stderr: "",
      timedOut: false,
    });

    expect(await fetchX({ queries: ["@a"], max: 10, runner })).toEqual({ ok: false, error: "x_rate_limited" });
  });

  it("skips a bad @handle and keeps the others (best effort)", async () => {
    const skipped: string[] = [];
    const runner: Runner = async (_cmd, args) =>
      args[1] === "bad_handle"
        ? {
            code: 1,
            stdout: JSON.stringify({ ok: false, schema_version: "1", error: { code: "not_found", message: "HTTP 404" } }),
            stderr: "",
            timedOut: false,
          }
        : { code: 0, stdout: JSON.stringify(fixture), stderr: "", timedOut: false };

    const result = await fetchX({
      queries: ["@good", "@bad_handle"],
      max: 10,
      runner,
      onSkip: (q, e) => skipped.push(`${q}: ${e}`),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.length).toBe(tweets.length);
    expect(skipped).toEqual(["@bad_handle: x_search_failed: not_found"]);
  });

  it("an auth error still aborts the whole run", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: JSON.stringify({ ok: false, schema_version: "1", error: { code: "not_authenticated", message: "x" } }),
      stderr: "",
      timedOut: false,
    });
    expect(await fetchX({ queries: ["@a", "@b"], max: 10, runner })).toEqual({ ok: false, error: "x_auth" });
  });

  it("routes only search through searchVia (the x.com/home shim)", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify(fixture), stderr: "", timedOut: false };
    };

    await fetchX({
      queries: ["ai agents", "@someone"],
      max: 5,
      runner,
      searchVia: { cmd: "/py", prefix: ["/shim.py"] },
    });

    expect(calls).toEqual([
      { cmd: "/py", args: ["/shim.py", "search", "ai agents", "-t", "latest", "-n", "5", "--json"] },
      { cmd: "twitter", args: ["user-posts", "someone", "-n", "5", "--json"] },
    ]);
  });

  it("falls back to a narrow stderr match when stdout isn't a parseable envelope", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: "not json at all",
      stderr: "twitter-cli: cookie file missing, run `twitter login`",
      timedOut: false,
    });

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(result).toEqual({ ok: false, error: "x_auth" });
  });

  it("reports a generic search failure when stdout isn't parseable and stderr has no auth signal", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: "not json at all",
      stderr: "boom: unexpected internal error",
      timedOut: false,
    });

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(result).toEqual({ ok: false, error: "x_search_failed" });
  });

  it("routes 'feed' query to the read-only feed command", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify({ ok: true, schema_version: "1", data: [] }), stderr: "", timedOut: false };
    };

    await fetchX({ queries: ["feed"], max: 7, runner });

    expect(calls).toEqual([{ cmd: "twitter", args: ["feed", "-n", "7", "--json"] }]);
  });

  it("routes an '@handle' query to the read-only user-posts command", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify({ ok: true, schema_version: "1", data: [] }), stderr: "", timedOut: false };
    };

    await fetchX({ queries: ["@someuser"], max: 7, runner });

    expect(calls).toEqual([
      { cmd: "twitter", args: ["user-posts", "someuser", "-n", "7", "--json"] },
    ]);
  });

  it("routes a 'list:<id>' query to the read-only list command", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify({ ok: true, schema_version: "1", data: [] }), stderr: "", timedOut: false };
    };

    await fetchX({ queries: ["list:12345"], max: 7, runner });

    expect(calls).toEqual([{ cmd: "twitter", args: ["list", "12345", "-n", "7", "--json"] }]);
  });

  it("dedupes items by id across mixed feed/@handle/list/search queries", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      const subset =
        args[0] === "feed"
          ? [tweets[0]]
          : args[0] === "user-posts"
            ? [tweets[0], tweets[1]]
            : args[0] === "list"
              ? [tweets[1], tweets[2]]
              : [tweets[2]];
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, schema_version: "1", data: subset }),
        stderr: "",
        timedOut: false,
      };
    };

    const result = await fetchX({
      queries: ["feed", "@someuser", "list:12345", "search text"],
      max: 5,
      runner,
    });

    expect(calls).toEqual([
      { cmd: "twitter", args: ["feed", "-n", "5", "--json"] },
      { cmd: "twitter", args: ["user-posts", "someuser", "-n", "5", "--json"] },
      { cmd: "twitter", args: ["list", "12345", "-n", "5", "--json"] },
      { cmd: "twitter", args: ["search", "search text", "-t", "latest", "-n", "5", "--json"] },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    const ids = result.value.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([tweets[0].id, tweets[1].id, tweets[2].id].sort());
  });

  it("maps a 'not_found' error from the search command to 'x_search_unavailable'", async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        schema_version: "1",
        error: {
          code: "not_found",
          message: "Twitter API error (HTTP 404): endpoint not found.",
        },
      }),
      stderr: "",
      timedOut: false,
    });

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(result).toEqual({ ok: false, error: "x_search_unavailable" });
  });

  it("maps a non-numeric metric to 0, never NaN", async () => {
    const garbageTweet = {
      ...tweets[0],
      metrics: { ...tweets[0].metrics, likes: "banana" },
    };
    const runner: Runner = async () => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, schema_version: "1", data: [garbageTweet] }),
      stderr: "",
      timedOut: false,
    });

    const result = await fetchX({ queries: ["ai agents"], max: 10, runner });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    expect(result.value[0].metrics.likes).toBe(0);
    expect(Number.isNaN(result.value[0].metrics.likes)).toBe(false);
  });
});
