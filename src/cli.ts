// CLI: `signal-radar <x|tiktok|creators|mail> [sources...] [--top N] [--dry] [--json]`.
// Data lives in ~/.signal-radar (override with SIGNAL_RADAR_HOME or --home).
// The older `run --lane <lane> [--queries a,b] [--mail-file f] [--enrich-top N] [--db] [--out]`
// form still works.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { run, type Runner } from "./exec.ts";
import { createStore } from "./store.ts";
import type { Lane, Store } from "./types.ts";
import { runLane } from "./pipeline.ts";

export interface CliDeps {
  store?: Store;
  runner?: Runner;
  now?: () => Date;
}

interface ParsedArgs {
  lane: Lane;
  dry: boolean;
  json: boolean;
  db: string;
  out: string;
  queries?: string[];
  mailFile?: string;
  enrichTop: number;
}

const LANES: readonly Lane[] = ["x", "tiktok", "creators", "mail"];

const USAGE = `usage: signal-radar <lane> [sources...] [--top N] [--dry] [--json]

  signal-radar x                      your home feed
  signal-radar x @karpathy list:123   user posts, lists (or free-text search)
  signal-radar tiktok "gadgets" "#tiktokmademebuyit"
  signal-radar creators               shortlist authors of top posts
  signal-radar mail ~/export.json     sort a Gmail JSON export

  --top N    how many top items grok enriches and delivers (default 10)
  --dry      write the digest but deliver nothing
  --json     print counts as JSON
  --home DIR data dir (default ~/.signal-radar, or $SIGNAL_RADAR_HOME)`;

function isLane(value: string | undefined): value is Lane {
  return !!value && (LANES as readonly string[]).includes(value);
}

function defaultHome(): string {
  return process.env.SIGNAL_RADAR_HOME || join(homedir(), ".signal-radar");
}

function parseLegacy(argv: string[]): ParsedArgs | { error: string } {
  let lane: Lane | undefined;
  let dry = false;
  let db = join(defaultHome(), "radar.db");
  let out = defaultHome();
  let queries: string[] | undefined;
  let mailFile: string | undefined;
  let enrichTop = 10;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--lane": {
        const value = argv[++i];
        if (!isLane(value)) return { error: `invalid --lane: ${value ?? "(none)"}` };
        lane = value;
        break;
      }
      case "--dry":
        dry = true;
        break;
      case "--db":
        db = argv[++i] ?? db;
        break;
      case "--out":
        out = argv[++i] ?? out;
        break;
      case "--queries":
        queries = (argv[++i] ?? "")
          .split(",")
          .map((q) => q.trim())
          .filter((q) => q.length > 0);
        break;
      case "--mail-file":
        mailFile = argv[++i];
        break;
      case "--enrich-top": {
        const raw = argv[++i];
        const value = Number(raw);
        if (!Number.isFinite(value)) return { error: `invalid --enrich-top: ${raw}` };
        enrichTop = value;
        break;
      }
      default:
        return { error: `unknown flag: ${arg}` };
    }
  }

  if (!lane) return { error: "missing --lane" };

  return { lane, dry, json: true, db, out, queries, mailFile, enrichTop };
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  if (argv[0] === "run") return parseLegacy(argv);

  const lane = argv[0];
  if (!isLane(lane)) return { error: USAGE };

  let home = defaultHome();
  let dry = false;
  let json = false;
  let enrichTop = 10;
  const positional: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry":
        dry = true;
        break;
      case "--json":
        json = true;
        break;
      case "--home":
        home = argv[++i] ?? home;
        break;
      case "--top": {
        const raw = argv[++i];
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1) return { error: `invalid --top: ${raw}` };
        enrichTop = value;
        break;
      }
      default:
        if (arg.startsWith("--")) return { error: `unknown flag: ${arg}\n\n${USAGE}` };
        positional.push(arg);
    }
  }

  const parsed: ParsedArgs = {
    lane,
    dry,
    json,
    db: join(home, "radar.db"),
    out: home,
    enrichTop,
  };
  if (lane === "x") parsed.queries = positional.length ? positional : ["feed"];
  if (lane === "tiktok") {
    if (!positional.length) return { error: "tiktok needs at least one search term\n\n" + USAGE };
    parsed.queries = positional;
  }
  if (lane === "mail") {
    if (positional.length !== 1) return { error: "mail needs the path to a JSON export\n\n" + USAGE };
    parsed.mailFile = positional[0];
  }
  return parsed;
}

/** Parses argv, runs one lane, and prints the result. Returns the exit code; never calls
 * process.exit itself (only the entry point below does that). */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 1;
  }

  const runner = deps.runner ?? run;
  const now = deps.now ?? (() => new Date());
  const ownsStore = !deps.store;
  if (ownsStore && parsed.db !== ":memory:") {
    mkdirSync(dirname(parsed.db), { recursive: true });
  }
  const store = deps.store ?? createStore(parsed.db);

  try {
    const result = await runLane(parsed.lane, {
      store,
      runner,
      now,
      outDir: parsed.out,
      queries: parsed.queries,
      mailFile: parsed.mailFile,
      enrichTop: parsed.enrichTop,
      dry: parsed.dry,
    });

    if (!result.ok) {
      console.error(result.error);
      if (result.error === "x_rate_limited") console.error("X is rate-limiting this account; wait ~15 minutes.");
      return 1;
    }

    if (parsed.json) {
      console.log(JSON.stringify(result.value));
    } else {
      const c = result.value;
      const date = now().toISOString().slice(0, 10);
      console.log(`✓ ${c.fetched} fetched · ${c.inserted} new · ${c.enriched} enriched · ${c.delivered} delivered`);
      for (const s of c.skipped) console.log(`! skipped ${s}`);
      console.log(`→ ${join(parsed.out, `${date}.html`)}`);
    }
    return 0;
  } finally {
    if (ownsStore) store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
