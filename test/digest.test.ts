import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderHtml, renderMarkdown, writeDigest } from "../src/digest.ts";
import type { Item, Scored } from "../src/types.ts";

function item(overrides: Partial<Item> = {}): Item {
  return {
    lane: "x",
    id: "1",
    url: "https://x.com/user/status/1",
    author: "@user",
    text: "hello world",
    metrics: {},
    fetchedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

function scored(overrides: Partial<Scored> = {}): Scored {
  return {
    item: item(),
    answers: null,
    rank: 0.5,
    enrich: null,
    deliveredAt: null,
    ...overrides,
  };
}

describe("renderHtml", () => {
  it("escapes scraped text so raw markup never appears", () => {
    const s = scored({
      item: item({ text: "<script>alert(1)</script>", author: "<b>bob</b>" }),
      enrich: { why: "<img src=x onerror=alert(1)>", tags: ["<i>tag</i>"] },
    });
    const html = renderHtml("2026-09-24", [{ lane: "x", items: [s] }]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<b>bob</b>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<i>tag</i>");
  });

  it("rejects non-http(s) url schemes in href", () => {
    const s = scored({ item: item({ url: "javascript:alert(1)" }) });
    const html = renderHtml("2026-09-24", [{ lane: "x", items: [s] }]);
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("shows rank, author, link, enrich.why and tags", () => {
    const s = scored({
      item: item({ author: "jane", url: "https://example.com/post/1" }),
      rank: 0.42,
      enrich: { why: "novel insight", tags: ["ai", "tools"] },
    });
    const html = renderHtml("2026-09-24", [{ lane: "x", items: [s] }]);
    expect(html).toContain("#1");
    expect(html).toContain("jane");
    expect(html).toContain("https://example.com/post/1");
    expect(html).toContain("novel insight");
    expect(html).toContain("ai");
    expect(html).toContain("tools");
  });

  it("orders items by rank, highest first", () => {
    const low = scored({ item: item({ id: "low", author: "author-low" }), rank: 0.1 });
    const high = scored({ item: item({ id: "high", author: "author-high" }), rank: 0.9 });
    const mid = scored({ item: item({ id: "mid", author: "author-mid" }), rank: 0.5 });
    const html = renderHtml("2026-09-24", [{ lane: "x", items: [low, high, mid] }]);
    const highIdx = html.indexOf("author-high");
    const midIdx = html.indexOf("author-mid");
    const lowIdx = html.indexOf("author-low");
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it("supports light/dark scheme and a mobile viewport, with no external resources", () => {
    const html = renderHtml("2026-09-24", []);
    expect(html).toContain("prefers-color-scheme");
    expect(html).toContain('name="viewport"');
    expect(html).not.toContain("http://");
    expect(html).not.toMatch(/<script/);
  });
});

describe("renderMarkdown", () => {
  it("stays within the Telegram-friendly cap and notes how many more items were cut", () => {
    const items: Scored[] = Array.from({ length: 100 }, (_, i) =>
      scored({
        item: item({ id: `${i}`, author: `author-${i}`, text: "x".repeat(200) }),
        rank: 1 - i / 100,
      }),
    );
    const md = renderMarkdown("2026-09-24", [{ lane: "x", items }]);
    expect(md.length).toBeLessThanOrEqual(3500);
    expect(md).toMatch(/…and \d+ more/);
  });

  it("does not truncate when everything already fits", () => {
    const s = scored({ item: item({ author: "author-1" }) });
    const md = renderMarkdown("2026-09-24", [{ lane: "x", items: [s] }]);
    expect(md.length).toBeLessThanOrEqual(3500);
    expect(md).not.toMatch(/…and \d+ more/);
    expect(md).toContain("author-1");
  });
});

describe("writeDigest", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes <date>.html and digest.md into the given dir", async () => {
    dir = await mkdtemp(join(tmpdir(), "signal-radar-digest-"));
    const sections = [{ lane: "x" as const, items: [scored()] }];

    await writeDigest(dir, "2026-09-24", sections);

    const html = await readFile(join(dir, "2026-09-24.html"), "utf8");
    const md = await readFile(join(dir, "digest.md"), "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("@user");
    expect(md.length).toBeGreaterThan(0);
  });
});
