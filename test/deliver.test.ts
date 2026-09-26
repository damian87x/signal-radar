import { describe, expect, it, vi } from "vitest";
import type { Item, JevAnswers, Lane, Scored, Store } from "../src/types.ts";
import { deliver } from "../src/deliver.ts";

/** In-memory fake implementing the shared Store contract, for this test only. */
function makeFakeStore(seed: Scored[]): Store {
  const rows = new Map<string, Scored>();
  for (const s of seed) rows.set(`${s.item.lane}:${s.item.id}`, s);

  return {
    upsert(items: Item[]) {
      return items.length;
    },
    setScore(_lane: Lane, _id: string, _answers: JevAnswers | null, _rank: number | null) {},
    setEnrich(_lane: Lane, _id: string, _enrich: Record<string, unknown>) {},
    undelivered(lane: Lane, limit: number) {
      return [...rows.values()]
        .filter((s) => s.item.lane === lane && s.deliveredAt === null)
        .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
        .slice(0, limit);
    },
    unscored() {
      return [];
    },
    markDelivered(lane: Lane, ids: string[], at: string) {
      for (const id of ids) {
        const key = `${lane}:${id}`;
        const existing = rows.get(key);
        if (existing) rows.set(key, { ...existing, deliveredAt: at });
      }
    },
    since() {
      return [];
    },
    close() {},
  };
}

function item(id: string, text: string): Item {
  return {
    lane: "x",
    id,
    url: `https://x.com/${id}`,
    author: "author",
    text,
    metrics: {},
    fetchedAt: "2026-09-24T00:00:00.000Z",
  };
}

function scored(id: string, text: string, rank: number): Scored {
  return {
    item: item(id, text),
    answers: null,
    rank,
    enrich: null,
    deliveredAt: null,
  };
}

describe("deliver", () => {
  it("sends undelivered items once, renders markdown, marks delivered only after send resolves, and returns the count", async () => {
    const store = makeFakeStore([scored("1", "first post", 0.9), scored("2", "second post", 0.5)]);
    const send = vi.fn(async (_md: string) => {});

    const count = await deliver(store, "x", { limit: 10, send, now: "2026-09-24T01:00:00.000Z" });

    expect(count).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    const [md] = send.mock.calls[0]!;
    expect(md).toContain("first post");
    expect(md).toContain("second post");
    expect(store.undelivered("x", 10)).toEqual([]);
  });

  it("second deliver() run sends 0 items and does not call send again", async () => {
    const store = makeFakeStore([scored("1", "only post", 0.9)]);
    const send = vi.fn(async (_md: string) => {});

    const first = await deliver(store, "x", { limit: 10, send, now: "2026-09-24T01:00:00.000Z" });
    expect(first).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);

    const second = await deliver(store, "x", { limit: 10, send, now: "2026-09-24T02:00:00.000Z" });
    expect(second).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not call send when there are 0 undelivered items", async () => {
    const store = makeFakeStore([]);
    const send = vi.fn(async (_md: string) => {});

    const count = await deliver(store, "x", { limit: 10, send, now: "2026-09-24T01:00:00.000Z" });

    expect(count).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("marks nothing when send throws", async () => {
    const store = makeFakeStore([scored("1", "will fail", 0.9)]);
    const send = vi.fn(async (_md: string) => {
      throw new Error("network down");
    });

    await expect(
      deliver(store, "x", { limit: 10, send, now: "2026-09-24T01:00:00.000Z" }),
    ).rejects.toThrow("network down");

    expect(store.undelivered("x", 10)).toHaveLength(1);
    expect(store.undelivered("x", 10)[0]!.item.id).toBe("1");
  });

  it("uses an injected render fn instead of the default", async () => {
    const store = makeFakeStore([scored("1", "custom render post", 0.9)]);
    const send = vi.fn(async (_md: string) => {});
    const render = vi.fn((items: Scored[]) => `CUSTOM:${items.length}`);

    await deliver(store, "x", { limit: 10, send, now: "2026-09-24T01:00:00.000Z", render });

    expect(render).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("CUSTOM:1");
  });
});

describe("deliver scoped to ids", () => {
  it("only delivers items whose id is in `ids`, even when higher-ranked backlog exists", async () => {
    const store = makeFakeStore([scored("backlog", "old post", 0.99), scored("fresh", "new post", 0.5)]);
    const send = vi.fn(async () => {});
    const n = await deliver(store, "x", { limit: 5, send, now: "t", ids: new Set(["fresh"]) });
    expect(n).toBe(1);
    expect(store.undelivered("x", 10).map((s) => s.item.id)).toEqual(["backlog"]);
  });
});
