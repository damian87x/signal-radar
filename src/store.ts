import { DatabaseSync } from "node:sqlite";
import type { Item, JevAnswers, Lane, Scored, Store } from "./types.ts";

interface Row {
  lane: string;
  id: string;
  url: string;
  author: string;
  text: string;
  metrics_json: string;
  created_at: string | null;
  fetched_at: string;
  answers_json: string | null;
  rank: number | null;
  enrich_json: string | null;
  delivered_at: string | null;
}

function rowToItem(row: Row): Item {
  return {
    lane: row.lane as Lane,
    id: row.id,
    url: row.url,
    author: row.author,
    text: row.text,
    metrics: JSON.parse(row.metrics_json) as Record<string, number>,
    createdAt: row.created_at ?? undefined,
    fetchedAt: row.fetched_at,
  };
}

function rowToScored(row: Row): Scored {
  return {
    item: rowToItem(row),
    answers: row.answers_json ? (JSON.parse(row.answers_json) as JevAnswers) : null,
    rank: row.rank,
    enrich: row.enrich_json ? (JSON.parse(row.enrich_json) as Record<string, unknown>) : null,
    deliveredAt: row.delivered_at,
  };
}

/** SQLite-backed Store (node:sqlite). */
export function createStore(path: string): Store {
  const db = new DatabaseSync(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      lane TEXT NOT NULL,
      id TEXT NOT NULL,
      url TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      created_at TEXT,
      fetched_at TEXT NOT NULL,
      answers_json TEXT,
      rank REAL,
      enrich_json TEXT,
      delivered_at TEXT,
      PRIMARY KEY (lane, id)
    )
  `);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO items
      (lane, id, url, author, text, metrics_json, created_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const setScoreStmt = db.prepare(
    `UPDATE items SET answers_json = ?, rank = ? WHERE lane = ? AND id = ?`,
  );

  const setEnrichStmt = db.prepare(
    `UPDATE items SET enrich_json = ? WHERE lane = ? AND id = ?`,
  );

  const undeliveredStmt = db.prepare(
    `SELECT * FROM items WHERE lane = ? AND rank IS NOT NULL AND delivered_at IS NULL ORDER BY rank DESC LIMIT ?`,
  );

  const unscoredStmt = db.prepare(
    `SELECT * FROM items WHERE lane = ? AND rank IS NULL ORDER BY rowid ASC LIMIT ?`,
  );

  return {
    upsert(items) {
      let inserted = 0;
      for (const item of items) {
        const result = insertStmt.run(
          item.lane,
          item.id,
          item.url,
          item.author,
          item.text,
          JSON.stringify(item.metrics),
          item.createdAt ?? null,
          item.fetchedAt,
        );
        inserted += Number(result.changes);
      }
      return inserted;
    },

    setScore(lane, id, answers, rank) {
      setScoreStmt.run(answers ? JSON.stringify(answers) : null, rank, lane, id);
    },

    setEnrich(lane, id, enrich) {
      setEnrichStmt.run(JSON.stringify(enrich), lane, id);
    },

    undelivered(lane, limit) {
      const rows = undeliveredStmt.all(lane, limit) as unknown as Row[];
      return rows.map(rowToScored);
    },

    unscored(lane, limit) {
      const rows = unscoredStmt.all(lane, limit) as unknown as Row[];
      return rows.map(rowToItem);
    },

    markDelivered(lane, ids, at) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(", ");
      db
        .prepare(`UPDATE items SET delivered_at = ? WHERE lane = ? AND id IN (${placeholders})`)
        .run(at, lane, ...ids);
    },

    close() {
      db.close();
    },
  };
}
