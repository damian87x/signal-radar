import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Lane, Scored } from "./types.ts";

export interface DigestSection {
  lane: Lane;
  items: Scored[];
}

const MD_MAX_CHARS = 3500;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) URLs are safe to render as a link; everything else is rejected. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function sortByRank(items: Scored[]): Scored[] {
  return [...items].sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity));
}

function enrichWhy(scored: Scored): string | null {
  const why = scored.enrich?.["why"];
  return typeof why === "string" ? why : null;
}

function enrichTags(scored: Scored): string[] {
  const tags = scored.enrich?.["tags"];
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
}

/** Every other string field Grok returned (outreach_angle, product_name, lead, ...), labelled. */
function enrichExtras(scored: Scored): Array<[string, string]> {
  return Object.entries(scored.enrich ?? {})
    .filter(([k, v]) => k !== "why" && k !== "tags" && typeof v === "string" && v.trim() !== "")
    .map(([k, v]) => [k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), v as string]);
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function renderItemHtml(rank: number, scored: Scored): string {
  const item = scored.item;
  const href = safeHref(item.url);
  const linkHtml = href
    ? `<a href="${escapeHtml(href)}">${escapeHtml(item.url)}</a>`
    : escapeHtml(item.url);
  const why = enrichWhy(scored);
  const tags = enrichTags(scored);
  return `<li class="item">
  <span class="rank">#${rank}</span>
  <span class="author">${escapeHtml(item.author)}</span>
  <p class="text">${escapeHtml(item.text)}</p>
  ${why ? `<p class="why">${escapeHtml(why)}</p>` : ""}
  ${enrichExtras(scored)
    .map(([label, value]) => `<p class="extra"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`)
    .join("\n  ")}
  ${tags.length ? `<p class="tags">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ")}</p>` : ""}
  <p class="link">${linkHtml}</p>
</li>`;
}

function renderSectionHtml(section: DigestSection): string {
  const itemsHtml = sortByRank(section.items)
    .map((scored, i) => renderItemHtml(i + 1, scored))
    .join("\n");
  return `<section>
  <h2>${escapeHtml(section.lane)}</h2>
  <ol class="items">
${itemsHtml}
  </ol>
</section>`;
}

/** Self-contained HTML digest: no external fonts, scripts or images. */
export function renderHtml(date: string, sections: DigestSection[]): string {
  const sectionsHtml = sections.map(renderSectionHtml).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>signal-radar digest ${escapeHtml(date)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; background: #fff; color: #111; }
  a { color: #1a56db; word-break: break-all; }
  .items { list-style: none; padding: 0; margin: 0; }
  .item { border-bottom: 1px solid rgba(128,128,128,0.3); padding: 0.75rem 0; }
  .rank { font-weight: bold; margin-right: 0.5rem; }
  .why { font-style: italic; }
  .tag { display: inline-block; background: rgba(128,128,128,0.2); border-radius: 0.5rem; padding: 0.1rem 0.5rem; margin-right: 0.25rem; font-size: 0.85em; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; }
    a { color: #8ab4f8; }
  }
  @media (max-width: 480px) {
    body { padding: 0.5rem; font-size: 16px; }
  }
</style>
</head>
<body>
  <h1>signal-radar — ${escapeHtml(date)}</h1>
  ${sectionsHtml}
</body>
</html>`;
}

function renderItemMarkdown(rank: number, scored: Scored): string {
  const item = scored.item;
  const href = safeHref(item.url);
  const why = enrichWhy(scored);
  const tags = enrichTags(scored);
  const lines = [`${rank}. ${item.author} — ${truncate(item.text, 240)}`];
  if (why) lines.push(why);
  for (const [label, value] of enrichExtras(scored)) lines.push(`${label}: ${value}`);
  if (tags.length) lines.push(tags.map((t) => `#${t}`).join(" "));
  if (href) lines.push(href);
  return `${lines.join("\n")}\n`;
}

interface MdBlock {
  text: string;
}

/** Telegram-friendly digest: plain text, capped at MD_MAX_CHARS, truncates with a count of what was cut. */
export function renderMarkdown(date: string, sections: DigestSection[]): string {
  const header = `*signal-radar — ${date}*\n`;
  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);

  const blocks: MdBlock[] = [];
  for (const section of sections) {
    sortByRank(section.items).forEach((scored, i) => {
      const sectionHeader = i === 0 ? `\n*${section.lane}*\n` : "";
      blocks.push({ text: sectionHeader + renderItemMarkdown(i + 1, scored) });
    });
  }

  const full = header + blocks.map((b) => b.text).join("");
  if (full.length <= MD_MAX_CHARS) return full;

  // Upper bound on the footer's length: `remaining` can never exceed totalItems,
  // so its digit count never exceeds totalItems's digit count.
  const reserve = `\n…and ${totalItems} more`.length;
  let body = "";
  let shown = 0;
  for (const block of blocks) {
    const candidate = body + block.text;
    if (header.length + candidate.length + reserve > MD_MAX_CHARS) break;
    body = candidate;
    shown++;
  }
  const remaining = totalItems - shown;
  const footer = remaining > 0 ? `\n…and ${remaining} more` : "";
  return header + body + footer;
}

export async function writeDigest(dir: string, date: string, sections: DigestSection[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${date}.html`), renderHtml(date, sections), "utf8");
  await writeFile(join(dir, "digest.md"), renderMarkdown(date, sections), "utf8");
}
