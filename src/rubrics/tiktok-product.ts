// TikTok product lane rubric: spot products being sold/shown and momentum.
// Momentum is arithmetic (views/hour, log-scaled) computed here in code — Jev never does arithmetic.

import type { Item, JevAnswers, Rubric } from "../types.ts";
import { defuseMarkers } from "./defuse.ts";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// Floor on age so a video posted seconds ago doesn't produce a divide-by-near-zero spike.
const MIN_AGE_HOURS = 1 / 60;
// Views/hour treated as "as high as momentum gets" for the log scale; ~viral ceiling.
const VIEWS_PER_HOUR_CAP = 1_000_000;

/** Pure: views-per-hour since createdAt, log-scaled to [0,1]. No Jev involved. */
export function momentum(item: Item): number {
  if (!item.createdAt) return 0;
  const createdMs = Date.parse(item.createdAt);
  const fetchedMs = Date.parse(item.fetchedAt);
  if (Number.isNaN(createdMs) || Number.isNaN(fetchedMs)) return 0;
  const views = Math.max(item.metrics.views ?? 0, 0);
  const ageHours = Math.max((fetchedMs - createdMs) / 3_600_000, MIN_AGE_HOURS);
  const viewsPerHour = views / ageHours;
  const scaled = Math.log1p(viewsPerHour) / Math.log1p(VIEWS_PER_HOUR_CAP);
  return clamp(scaled, 0, 1);
}

function state(item: Item): string {
  return [
    `platform: tiktok`,
    `author: ${defuseMarkers(item.author)}`,
    `metrics: ${JSON.stringify(item.metrics)}`,
    `---CAPTION START---`,
    defuseMarkers(item.text),
    `---CAPTION END---`,
  ].join("\n");
}

function rank(answers: JevAnswers, item: Item): number {
  const product = answers.product;
  const buyIntent = answers.buy_intent;
  const productNoul = product?.type === "noul" ? product.noul : 0;
  const buyIntentNoul = buyIntent?.type === "noul" ? buyIntent.noul : 0;
  const m = momentum(item);
  return clamp(productNoul * (0.5 * m + 0.5 * buyIntentNoul), 0, 1);
}

function enrichPrompt(item: Item): string {
  return [
    "Identify the product sold or shown in this TikTok video.",
    "Extract a concise product_name, a short price_hint (e.g. \"$20\", \"under $50\", or \"unknown\" if not mentioned),",
    "and a one-sentence why_trending grounded in the caption and metrics.",
    "",
    state(item),
  ].join("\n");
}

export const tiktokProductRubric: Rubric = {
  lane: "tiktok",
  questions: [
    {
      id: "product",
      type: "noul",
      instructions: "A physical or digital product is sold or shown in this TikTok video.",
    },
    {
      id: "category",
      type: "choice",
      instructions: "Which category best fits the product shown or sold?",
      criteria: {
        beauty: "Beauty, skincare, cosmetics or personal care products.",
        gadgets: "Electronics, gadgets or tech accessories.",
        home: "Home goods, kitchen, decor or cleaning products.",
        fashion: "Clothing, shoes, jewelry or fashion accessories.",
        fitness: "Fitness equipment, supplements or workout gear.",
        food: "Food, drinks or snacks.",
        digital: "Digital products: apps, courses, templates or software.",
        other: "Does not fit any of the above categories, or no product is present.",
      },
    },
    {
      id: "buy_intent",
      type: "noul",
      instructions:
        "The caption or comments show purchase intent, such as asking where to buy, sharing a link or price, or urging viewers to buy.",
    },
  ],
  state,
  rank,
  // Real search results (2026-09-26): clear product videos with 10k-45k views over a few months
  // rank ~0.05-0.15, because captions rarely show buy intent. --top already caps Grok cost,
  // so the threshold only filters junk.
  threshold: 0.1,
  enrichSchema: {
    type: "object",
    properties: {
      product_name: { type: "string" },
      price_hint: { type: "string" },
      why_trending: { type: "string" },
    },
    required: ["product_name", "price_hint", "why_trending"],
    additionalProperties: false,
  },
  enrichPrompt,
};
