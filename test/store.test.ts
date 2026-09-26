import { describe, expect, it } from "vitest";
import { createStore } from "../src/store.ts";
import type { Item, JevAnswers } from "../src/types.ts";

function makeItem(id: string, overrides: Partial<Item> = {}): Item {
  return {
    lane: "x",
    id,
    url: `https://example.com/${id}`,
    author: "someone",
    text: `post ${id}`,
    metrics: { likes: 1 },
    fetchedAt: "2026-09-24T00:00:00Z",
    ...overrides,
  };
}

describe("createStore", () => {
  it("dedupes on (lane,id): second upsert of the same item returns 0 and leaves one row", () => {
    const store = createStore(":memory:");
    const item = makeItem("a");

    expect(store.upsert([item])).toBe(1);
    expect(store.upsert([item])).toBe(0);
    expect(store.unscored("x", 10)).toHaveLength(1);

    store.close();
  });

  it("persists setScore/setEnrich as JSON and undelivered() orders scored items by rank desc", () => {
    const store = createStore(":memory:");
    const itemA = makeItem("a");
    const itemB = makeItem("b");
    store.upsert([itemA, itemB]);

    const answersA: JevAnswers = { substantive: { type: "noul", noul: 0.9 } };
    const answersB: JevAnswers = { substantive: { type: "noul", noul: 0.4 } };
    store.setScore("x", "a", answersA, 0.4);
    store.setScore("x", "b", answersB, 0.9);
    store.setEnrich("x", "a", { why: "it matters" });

    const result = store.undelivered("x", 10);

    expect(result).toHaveLength(2);
    // rank desc: "b" (0.9) before "a" (0.4)
    expect(result[0].item.id).toBe("b");
    expect(result[0].rank).toBe(0.9);
    expect(result[0].answers).toEqual(answersB);
    expect(result[1].item.id).toBe("a");
    expect(result[1].rank).toBe(0.4);
    expect(result[1].answers).toEqual(answersA);
    expect(result[1].enrich).toEqual({ why: "it matters" });

    store.close();
  });

  it("unscored() returns only items with no score yet", () => {
    const store = createStore(":memory:");
    const itemA = makeItem("a");
    const itemB = makeItem("b");
    store.upsert([itemA, itemB]);
    store.setScore("x", "a", { substantive: { type: "noul", noul: 0.9 } }, 0.9);

    const result = store.unscored("x", 10);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");

    store.close();
  });

  it("undelivered() excludes unscored items", () => {
    const store = createStore(":memory:");
    const itemA = makeItem("a");
    const itemB = makeItem("b");
    store.upsert([itemA, itemB]);
    store.setScore("x", "a", { substantive: { type: "noul", noul: 0.9 } }, 0.9);
    // itemB is never scored.

    const result = store.undelivered("x", 10);

    expect(result).toHaveLength(1);
    expect(result[0].item.id).toBe("a");

    store.close();
  });

  it("markDelivered sets deliveredAt so the item drops out of undelivered()", () => {
    const store = createStore(":memory:");
    const itemA = makeItem("a");
    const itemB = makeItem("b");
    store.upsert([itemA, itemB]);
    store.setScore("x", "a", { substantive: { type: "noul", noul: 0.9 } }, 0.9);
    store.setScore("x", "b", { substantive: { type: "noul", noul: 0.4 } }, 0.4);

    store.markDelivered("x", ["a"], "2026-09-24T12:00:00Z");
    const result = store.undelivered("x", 10);

    expect(result).toHaveLength(1);
    expect(result[0].item.id).toBe("b");

    store.close();
  });
});
