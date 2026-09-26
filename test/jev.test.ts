import { describe, expect, it } from "vitest";
import { askJev, scoreItems } from "../src/jev.ts";
import type { ExecResult, Runner } from "../src/exec.ts";
import type { Item, JevAnswers, JevQuestion, Rubric } from "../src/types.ts";

const questions: JevQuestion[] = [
  { id: "substantive", type: "noul", instructions: "substantive AI insight, not hype" },
];

function makeItem(id: string, text: string): Item {
  return {
    lane: "x",
    id,
    url: `https://x.com/status/${id}`,
    author: "someone",
    text,
    metrics: { likes: 1 },
    fetchedAt: new Date().toISOString(),
  };
}

function stubRunner(result: ExecResult): Runner {
  return async () => result;
}

describe("askJev", () => {
  it("parses a successful response into JevAnswers matching the documented shape", async () => {
    const answers: JevAnswers = { substantive: { type: "noul", noul: 0.87 } };
    const runner = stubRunner({
      code: 0,
      stdout: JSON.stringify({ answers, usage: { tokens: 42 }, latency_ms: 681 }),
      stderr: "",
      timedOut: false,
    });

    const result = await askJev("some post text", questions, runner);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(answers);
      expect(result.value.substantive).toEqual({ type: "noul", noul: 0.87 });
    }
  });

  it("passes {state, questions} JSON on stdin to jev ask", async () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let capturedStdin: string | undefined;
    const runner: Runner = async (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedStdin = opts?.stdin;
      return {
        code: 0,
        stdout: JSON.stringify({ answers: {} }),
        stderr: "",
        timedOut: false,
      };
    };

    await askJev("the state text", questions, runner);

    expect(capturedCmd).toBe("jev");
    expect(capturedArgs).toContain("ask");
    expect(capturedStdin).toBeDefined();
    const parsedStdin = JSON.parse(capturedStdin as string);
    expect(parsedStdin).toEqual({ state: "the state text", questions });
  });

  it("yields ok:false with no answers on exit code 2 with an {error} body", async () => {
    const runner = stubRunner({
      code: 2,
      stdout: JSON.stringify({ error: "invalid_state", detail: "questions must not be empty" }),
      stderr: "",
      timedOut: false,
    });

    const result = await askJev("bad state", questions, runner);

    expect(result.ok).toBe(false);
  });

  it("yields ok:false on unparseable stdout, never throws", async () => {
    const runner = stubRunner({
      code: 0,
      stdout: "not json at all {{{",
      stderr: "",
      timedOut: false,
    });

    const result = await askJev("some state", questions, runner);

    expect(result.ok).toBe(false);
  });

  it("yields ok:false on timeout, never throws", async () => {
    const runner = stubRunner({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: true,
    });

    const result = await askJev("some state", questions, runner);

    expect(result.ok).toBe(false);
  });

  it("never throws even if the runner itself throws", async () => {
    const runner: Runner = async () => {
      throw new Error("spawn ENOENT");
    };

    await expect(askJev("some state", questions, runner)).resolves.toMatchObject({ ok: false });
  });
});

describe("scoreItems", () => {
  const rubric: Rubric = {
    lane: "x",
    questions,
    state: (item) => item.text,
    rank: (answers) => (answers.substantive.type === "noul" ? answers.substantive.noul : 0),
    threshold: 0.5,
    enrichSchema: {},
    enrichPrompt: () => "",
  };

  it("scores each item, attaching answers and rank on success", async () => {
    const items = [makeItem("1", "a substantive post"), makeItem("2", "another post")];
    const runner: Runner = async () => ({
      code: 0,
      stdout: JSON.stringify({ answers: { substantive: { type: "noul", noul: 0.7 } } }),
      stderr: "",
      timedOut: false,
    });

    const results = await scoreItems(items, rubric, { runner });

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.answers).toEqual({ substantive: { type: "noul", noul: 0.7 } });
      expect(r.rank).toBe(0.7);
      expect(r.error).toBeUndefined();
    }
  });

  it("marks failed items with null answers, null rank and an error, never throwing", async () => {
    const items = [makeItem("1", "post")];
    const runner: Runner = async () => ({
      code: 2,
      stdout: JSON.stringify({ error: "invalid_state" }),
      stderr: "",
      timedOut: false,
    });

    const results = await scoreItems(items, rubric, { runner });

    expect(results).toHaveLength(1);
    expect(results[0].answers).toBeNull();
    expect(results[0].rank).toBeNull();
    expect(results[0].error).toBeDefined();
  });

  it("catches a rubric rank() that throws, marking only that item as failed", async () => {
    const items = [makeItem("1", "throws"), makeItem("2", "ok")];
    const throwingRubric: Rubric = {
      ...rubric,
      rank: (answers, item) => {
        if (item.id === "1") throw new Error("boom");
        return (answers.substantive as { type: "noul"; noul: number }).noul;
      },
    };
    const runner: Runner = async () => ({
      code: 0,
      stdout: JSON.stringify({ answers: { substantive: { type: "noul", noul: 0.7 } } }),
      stderr: "",
      timedOut: false,
    });

    const results = await scoreItems(items, throwingRubric, { runner });

    expect(results).toHaveLength(2);
    const failed = results.find((r) => r.item.id === "1");
    const ok = results.find((r) => r.item.id === "2");
    expect(failed?.answers).toEqual({ substantive: { type: "noul", noul: 0.7 } });
    expect(failed?.rank).toBeNull();
    expect(failed?.error).toBe("rank_failed: boom");
    expect(ok?.answers).toEqual({ substantive: { type: "noul", noul: 0.7 } });
    expect(ok?.rank).toBe(0.7);
    expect(ok?.error).toBeUndefined();
  });

  it("bounds concurrency to the configured limit (default 8)", async () => {
    let active = 0;
    let maxActive = 0;
    const runner: Runner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return {
        code: 0,
        stdout: JSON.stringify({ answers: { substantive: { type: "noul", noul: 0.1 } } }),
        stderr: "",
        timedOut: false,
      };
    };

    const items = Array.from({ length: 20 }, (_, i) => makeItem(String(i), `post ${i}`));
    const results = await scoreItems(items, rubric, { runner, concurrency: 3 });

    expect(results).toHaveLength(20);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBe(3);
  });

  it("never lets concurrency exceed the default bound of 8", async () => {
    let active = 0;
    let maxActive = 0;
    const runner: Runner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return {
        code: 0,
        stdout: JSON.stringify({ answers: { substantive: { type: "noul", noul: 0.1 } } }),
        stderr: "",
        timedOut: false,
      };
    };

    const items = Array.from({ length: 30 }, (_, i) => makeItem(String(i), `post ${i}`));
    await scoreItems(items, rubric, { runner });

    expect(maxActive).toBeLessThanOrEqual(8);
  });
});

describe.skipIf(!process.env.LIVE)("askJev (LIVE)", () => {
  it("parses real jev ask output for a substantive and a hype post", async () => {
    const substantivePost =
      'Post: "We open-sourced the training code for our 7B model, including the exact data mixture, ' +
      'learning-rate schedule and the ablations that got us from 61% to 68% MMLU. Repo + writeup linked."';
    const hypePost =
      'Post: "🚀🚀 AI is about to change EVERYTHING. This is not a drill. The future is HERE. Nothing will ' +
      'ever be the same again!!! 🔥🔥🔥 #AI #disrupt"';

    const substantive = await askJev(substantivePost, questions);
    const hype = await askJev(hypePost, questions);

    expect(substantive.ok).toBe(true);
    expect(hype.ok).toBe(true);
  }, 30000);
});
