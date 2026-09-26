// Shared contract for every slice. Change only with the conductor's say-so.

export type Lane = "x" | "tiktok" | "creators" | "mail";

/** One fetched thing: a post, a video, a creator profile, an email. */
export interface Item {
  lane: Lane;
  id: string; // stable per lane: tweet id, video id, handle, message id
  url: string;
  author: string;
  text: string;
  metrics: Record<string, number>; // likes, views, followers, ... parsed in code
  createdAt?: string; // ISO, when the platform says it was made
  fetchedAt: string; // ISO
}

// `jev ask` request questions (stdin JSON: {"state": string, "questions": JevQuestion[]}).
export type JevQuestion =
  | { id: string; type: "noul"; instructions: string }
  | { id: string; type: "choice"; instructions: string; criteria: Record<string, string> }
  | { id: string; type: "score"; instructions: string; criteria: string[] };

// `jev ask` response, verified against jev 0.19.0 on 2026-09-24:
// {"answers": {"<id>": {...}}, "usage": {...}, "latency_ms": 681}
// Failure: exit 2 with {"error": "<code>", "detail"?: "..."} on stdout.
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score";
      score: number; // 0..levels-1, expected position
      probabilities: Record<string, number>;
      confidence: number;
      legend: Record<string, string>;
    };

export type JevAnswers = Record<string, JevAnswer>;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** A lane's scoring + enrichment recipe. Rubrics are data plus a pure rank function. */
export interface Rubric {
  lane: Lane;
  questions: JevQuestion[];
  /** Builds the `state` text Jev reads. Scraped text must be delimited as data. */
  state(item: Item): string;
  /** Pure: answers -> rank in [0,1]. Higher is better. */
  rank(answers: JevAnswers, item: Item): number;
  /** Items with rank >= threshold go to grok. */
  threshold: number;
  /** JSON Schema grok must satisfy. */
  enrichSchema: object;
  enrichPrompt(item: Item): string;
}

export interface Scored {
  item: Item;
  answers: JevAnswers | null; // null = jev failed, item unscored
  rank: number | null;
  enrich: Record<string, unknown> | null;
  deliveredAt: string | null;
}

/** Persistence (src/store.ts implements with node:sqlite). */
export interface Store {
  /** Inserts new items, ignores (lane,id) already present. Returns count inserted. */
  upsert(items: Item[]): number;
  setScore(lane: Lane, id: string, answers: JevAnswers | null, rank: number | null): void;
  setEnrich(lane: Lane, id: string, enrich: Record<string, unknown>): void;
  /** Scored, undelivered, rank desc. */
  undelivered(lane: Lane, limit: number): Scored[];
  /** Unscored items for a lane. */
  unscored(lane: Lane, limit: number): Item[];
  markDelivered(lane: Lane, ids: string[], at: string): void;
  close(): void;
}
