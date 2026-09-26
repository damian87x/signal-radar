// Read-only guard: statically scans every file under src/ for write-side CLI subcommands
// (twitter, opencli, grok) and HTTP write methods (fetch/http request POST/PUT/DELETE).
// Scans argv string literals inside runner(...)/spawn(...) calls (and array variables fed
// into them), not prose, so comments and doc strings never trip a false positive.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const TWITTER_WRITE_COMMANDS = new Set([
  "post",
  "reply",
  "quote",
  "like",
  "unlike",
  "retweet",
  "unretweet",
  "follow",
  "unfollow",
  "bookmark",
  "unbookmark",
  "favorite",
  "unfavorite",
  "delete",
]);

// Applies to opencli generally, including any instagram/tiktok adapter driven through it:
// these are generic browser-write actions regardless of which site the session is on.
const OPENCLI_WRITE_COMMANDS = new Set([
  "click",
  "type",
  "fill",
  "upload",
  "drag",
  "keys",
  "dialog",
  "dblclick",
  "select",
  "check",
  "uncheck",
]);

const GROK_WRITE_FLAGS = new Set(["--always-approve", "bypassPermissions", "acceptEdits"]);

const HTTP_WRITE_METHODS = new Set(["POST", "PUT", "DELETE"]);

const RUNNER_COMMAND_FAMILIES: Record<string, Set<string> | undefined> = {
  twitter: TWITTER_WRITE_COMMANDS,
  opencli: OPENCLI_WRITE_COMMANDS,
  grok: GROK_WRITE_FLAGS,
};

// ---------------------------------------------------------------------------
// Minimal tokenizer: strips comments (so prose never contributes tokens) and
// produces string/ident/punct tokens so calls can be matched structurally.
// ---------------------------------------------------------------------------

type TokType = "string" | "ident" | "punct";
interface Tok {
  type: TokType;
  value: string;
  pos: number;
}

const PUNCT_CHARS = "()[]{},.=;:";

function tokenize(src: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const start = i;
      let j = i + 1;
      let value = "";
      while (j < n && src[j] !== quote) {
        if (src[j] === "\\") {
          value += src[j]! + (src[j + 1] ?? "");
          j += 2;
          continue;
        }
        value += src[j];
        j++;
      }
      tokens.push({ type: "string", value, pos: start });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      tokens.push({ type: "ident", value: src.slice(i, j), pos: start });
      i = j;
      continue;
    }
    if (PUNCT_CHARS.includes(c)) {
      tokens.push({ type: "punct", value: c, pos: i });
      i++;
      continue;
    }
    i++;
  }
  return tokens;
}

function lineOf(src: string, pos: number): number {
  let line = 1;
  for (let k = 0; k < pos && k < src.length; k++) if (src[k] === "\n") line++;
  return line;
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** Given the index of an opening bracket token, returns the index just past its matching close. */
function matchClose(tokens: Tok[], openIndex: number): number {
  let depth = 1;
  let i = openIndex + 1;
  for (; i < tokens.length && depth > 0; i++) {
    const t = tokens[i]!;
    if (t.type === "punct" && OPEN.has(t.value)) depth++;
    else if (t.type === "punct" && CLOSE.has(t.value)) depth--;
  }
  return i;
}

/** Maps `const/let/var <ident> = [...]` (plus later `<ident>.push(...)`) to the set of string
 * literals they contain, so a runner call that forwards a pre-built args array is still scanned. */
function collectArrayIdents(tokens: Tok[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const get = (name: string): Set<string> => {
    let s = map.get(name);
    if (!s) {
      s = new Set();
      map.set(name, s);
    }
    return s;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    if (
      t.type === "ident" &&
      (t.value === "const" || t.value === "let" || t.value === "var") &&
      tokens[i + 1]?.type === "ident" &&
      tokens[i + 2]?.type === "punct" &&
      tokens[i + 2]?.value === "=" &&
      tokens[i + 3]?.type === "punct" &&
      tokens[i + 3]?.value === "["
    ) {
      const name = tokens[i + 1]!.value;
      const openIdx = i + 3;
      const endIdx = matchClose(tokens, openIdx);
      const set = get(name);
      for (let k = openIdx + 1; k < endIdx - 1; k++) {
        if (tokens[k]!.type === "string") set.add(tokens[k]!.value);
      }
      i = endIdx - 1;
      continue;
    }

    if (
      t.type === "ident" &&
      tokens[i + 1]?.type === "punct" &&
      tokens[i + 1]?.value === "." &&
      tokens[i + 2]?.type === "ident" &&
      tokens[i + 2]?.value === "push" &&
      tokens[i + 3]?.type === "punct" &&
      tokens[i + 3]?.value === "("
    ) {
      const openIdx = i + 3;
      const endIdx = matchClose(tokens, openIdx);
      const set = get(t.value);
      for (let k = openIdx + 1; k < endIdx - 1; k++) {
        if (tokens[k]!.type === "string") set.add(tokens[k]!.value);
      }
      i = endIdx - 1;
      continue;
    }
  }

  return map;
}

interface Violation {
  file: string;
  line: number;
  message: string;
}

/** Flags any identifier call (run(...), runner(...), spawn(...), execFile(...), exec(...),
 * deps.runner(...), opts.runner(...), ...) whose first string argument is a known CLI command
 * ("twitter"|"opencli"|"grok"|"jev") and whose argv contains a write-side subcommand or flag,
 * including args forwarded through a separately declared array. Matching is driven purely by
 * the call's arguments, not the callee name, so any wrapper/injected runner is still caught. */
function scanRunnerCalls(
  file: string,
  src: string,
  tokens: Tok[],
  arrayIdents: Map<string, Set<string>>,
): Violation[] {
  const violations: Violation[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (
      t.type === "ident" &&
      tokens[i + 1]?.type === "punct" &&
      tokens[i + 1]?.value === "("
    ) {
      const openIdx = i + 1;
      const endIdx = matchClose(tokens, openIdx);
      const bodyTokens = tokens.slice(openIdx + 1, endIdx - 1);

      const firstString = bodyTokens.find((bt) => bt.type === "string");
      const command = firstString?.value;
      const bannedSet = command ? RUNNER_COMMAND_FAMILIES[command] : undefined;

      if (bannedSet) {
        const candidates = new Set<string>();
        for (const bt of bodyTokens) {
          if (bt.type === "string") candidates.add(bt.value);
          if (bt.type === "ident" && arrayIdents.has(bt.value)) {
            for (const v of arrayIdents.get(bt.value)!) candidates.add(v);
          }
        }
        for (const c of candidates) {
          if (bannedSet.has(c)) {
            violations.push({
              file,
              line: lineOf(src, t.pos),
              message: `${t.value}("${command}", ...) contains banned write-side token "${c}"`,
            });
          }
        }
      }

      i = endIdx - 1;
      continue;
    }
  }

  return violations;
}

/** Flags fetch(...)/request(...) calls whose options contain `method: "POST"|"PUT"|"DELETE"`. */
function scanHttpWrites(file: string, src: string, tokens: Tok[]): Violation[] {
  const violations: Violation[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const isHttpCall = t.type === "ident" && (t.value === "fetch" || t.value === "request");
    if (isHttpCall && tokens[i + 1]?.type === "punct" && tokens[i + 1]?.value === "(") {
      const openIdx = i + 1;
      const endIdx = matchClose(tokens, openIdx);
      const bodyTokens = tokens.slice(openIdx + 1, endIdx - 1);

      for (let k = 0; k < bodyTokens.length - 2; k++) {
        const a = bodyTokens[k]!;
        const b = bodyTokens[k + 1]!;
        const c = bodyTokens[k + 2]!;
        if (
          a.type === "ident" &&
          a.value === "method" &&
          b.type === "punct" &&
          b.value === ":" &&
          c.type === "string" &&
          HTTP_WRITE_METHODS.has(c.value.toUpperCase())
        ) {
          violations.push({
            file,
            line: lineOf(src, t.pos),
            message: `${t.value}(...) uses write HTTP method "${c.value}"`,
          });
        }
      }

      i = endIdx - 1;
      continue;
    }
  }

  return violations;
}

function scanSource(file: string, src: string): Violation[] {
  const tokens = tokenize(src);
  const arrayIdents = collectArrayIdents(tokens);
  return [...scanRunnerCalls(file, src, tokens, arrayIdents), ...scanHttpWrites(file, src, tokens)];
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe("readonly guard: scanner self-checks (proves the scanner can fail)", () => {
  it("flags a twitter write-side subcommand", () => {
    const violations = scanSource("inline.ts", "runner('twitter', ['post', 'x'])");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("flags an opencli write-side subcommand", () => {
    const violations = scanSource("inline.ts", 'runner("opencli", ["browser", s, "click", "3"])');
    expect(violations.length).toBeGreaterThan(0);
  });

  it("flags a grok bypass-permission flag, even when routed through a separate args array", () => {
    const violations = scanSource(
      "inline.ts",
      'const args = ["-p", "x", "--permission-mode", "bypassPermissions"];\nrunner("grok", args);',
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("flags a POST fetch call", () => {
    const violations = scanSource("inline.ts", 'fetch(url, { method: "POST" })');
    expect(violations.length).toBeGreaterThan(0);
  });

  it("does not flag a clean read-only twitter call", () => {
    const violations = scanSource("inline.ts", "runner('twitter', ['search', 'query', '--json'])");
    expect(violations).toEqual([]);
  });

  it("does not flag a write-side word that only appears in a comment", () => {
    const violations = scanSource(
      "inline.ts",
      "// never click follow\nrunner('twitter', ['search', 'query'])",
    );
    expect(violations).toEqual([]);
  });

  it("flags a write-side call named run(...), not only runner(...)", () => {
    const violations = scanSource("inline.ts", 'run("twitter", ["post", "hello"]);');
    expect(violations.length).toBeGreaterThan(0);
  });

  it("flags a write-side call named spawn(...) with single-quoted argv", () => {
    const violations = scanSource(
      "inline.ts",
      "spawn('opencli', ['browser', s, 'click', '3']);",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("flags a write-side call reached through a member expression like opts.runner(...)", () => {
    const violations = scanSource(
      "inline.ts",
      'opts.runner("grok", ["-p", p, "--always-approve"]);',
    );
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("readonly guard: real source tree", () => {
  it("has no write-side runner/spawn calls or POST/PUT/DELETE http writes under src/", () => {
    const files = listFilesRecursive(SRC_DIR).filter((f) => /\.(ts|js|mts|cts)$/.test(f));
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((f) =>
      scanSource(path.relative(SRC_DIR, f), readFileSync(f, "utf-8")),
    );

    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("grok.ts runs headless: no tools, no web search, plan-only permission mode", () => {
    const grokSrc = readFileSync(path.join(SRC_DIR, "grok.ts"), "utf-8");
    expect(grokSrc).toContain('"--tools"');
    expect(grokSrc).toContain('"--disable-web-search"');
    expect(grokSrc).toMatch(/"--permission-mode"\s*,\s*"plan"/);
  });
});
