# signal-radar

A local, read-only radar for four lanes: X posts, TikTok products, creators,
and email. [TypeSafe Jev](https://typesafe.ai) scores every item in under a
second for a fraction of a cent. Headless [Grok](https://x.ai) writes a
one-line "why it matters" for only the top few. You get a digest.

```bash
signal-radar x                      # good AI posts from your home feed
signal-radar x @karpathy list:123   # specific accounts / lists
signal-radar tiktok "ai gadget"     # products being sold, with momentum
signal-radar creators               # shortlist authors of top posts + outreach angle drafts
signal-radar mail ~/export.json     # brand-deal and sponsorship leads in your inbox
```

It ships three ways from this one repo:

| | Install | You get |
|---|---|---|
| CLI | `npm i -g github:damian87x/signal-radar` | the `signal-radar` command |
| pi | `pi install git:github.com/damian87x/signal-radar` | `signal_radar` tool, `/radar` command, `signal-radar` skill |
| Claude Code | `claude plugin marketplace add damian87x/signal-radar` then `claude plugin install signal-radar@signal-radar` | `signal-radar` skill, `/signal-radar:radar` command |

The pi and Claude Code integrations call the CLI, so install it too.
Requirements: Node 24; the `jev` CLI on your PATH with a TypeSafe key; and
the `grok` CLI (xAI Grok Build), logged in, for enrichment. Each lane also needs
its own source tool; see Credentials below.

`jev` ships as `bin/jev` in
[hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills). It is
stdlib-only Python, needs no Hermes, and runs from its checkout:

```bash
git clone --depth 1 https://github.com/kerpopule/hermes-jev-skills ~/.local/share/hermes-jev-skills
ln -s ~/.local/share/hermes-jev-skills/bin/jev ~/.local/bin/jev
jev doctor
```

## How it works

For each run:

1. **Fetch.** Each source you name (`@handle`, `list:<id>`, a TikTok term...)
   is fetched and upserted into a local SQLite store (deduped on `(lane, id)`).
   A source that fails — a mistyped handle, an empty TikTok page — is skipped
   and printed as `! skipped <source>: <error>`; the rest of the run continues.
2. **Score.** `jev ask` scores every unscored item in the store against the
   lane's rubric (`src/rubrics/*.ts`) — fast and cheap, no LLM generation.
3. **Enrich.** `grok` (headless, schema-constrained) enriches only the top
   `--top` items *fetched by this run* that clear the rubric's rank threshold.
   Items already enriched are never re-sent to grok.
4. **Deliver.** On a non-dry run, the top undelivered items fetched by this run
   are marked delivered and written to a new
   `<home>/outbox/<timestamp>-<lane>.md` file, so `signal-radar x @a` never
   sends a post from `@b` fetched earlier.
5. **Digest.** `<home>/<date>.html` and `digest.md` are rewritten on every run
   and cover every lane seen that day (not just the last run), including
   Grok's extra fields such as the creators lane's outreach angle.

The delivery step writes files only. A pi job is expected to forward each
outbox file to Telegram and then delete it — signal-radar itself never talks
to Telegram.

## Develop

```bash
git clone https://github.com/damian87x/signal-radar && cd signal-radar
npm ci && npm link    # global `signal-radar` pointing at this checkout
npm test
```

The store uses `node:sqlite`, so Node 24 is required.

## Credentials

### X — twitter-cli cookies

The X lane shells out to the `twitter` CLI (agent-reach backend), which needs
an authenticated cookie session:

```bash
pbpaste | agent-reach configure twitter-cookies --stdin   # or: xclip -o | ...
# --stdin keeps the cookies out of the process list; --from-browser chrome also works
twitter status   # confirm the session is authenticated
```

Export cookies for x.com with the Cookie-Editor browser extension and paste
the JSON. Cookies expire; re-run `twitter status` if the X lane starts
failing with an auth error.

### TikTok — opencli + logged-in Chrome

The TikTok lane reads `tiktok.com/search` result pages through `opencli`'s
bridge to a Chrome profile that is already logged into TikTok (hashtags such as
`#tiktokmademebuyit` are searched too; `/tag/` pages rendered no videos when
tested). No separate credential step in this repo — make sure `opencli` is
running and the Chrome profile is signed in before running the `tiktok` lane.
Search cards show views but no date, so a video's age (for momentum) is decoded
from its id, whose upper 32 bits are the Unix posting time.

### Mail — JSON export

The mail lane reads a local JSON export, not a live Gmail connection. Each
message needs `id`, `subject`, `from`, one of `snippet`/`content`, and
`date`:

```json
[{ "id": "1", "subject": "...", "from": "a@b.com", "snippet": "...", "date": "2026-09-24" }]
```

**Warning:** `jev mail` sends the message subject and content (as a temp
file, never stdin) to TypeSafe's API for sorting. Only run the mail lane on
an export you're comfortable sending off-machine.

## X query forms

Each source after `signal-radar x` (default: `feed`) maps to a read-only
`twitter` subcommand:

- `feed` — home timeline (`twitter feed`)
- `@handle` — a user's posts (`twitter user-posts`)
- `list:<id>` — a Twitter List (`twitter list`)
- anything else — free-text search (`twitter search`)

**Search workaround.** Plain `twitter-cli` 0.8.5 `search` returns HTTP 404
([twitter-cli#88](https://github.com/public-clis/twitter-cli/issues/88)): x.com's
new homepage no longer links the script it needs for the
`x-client-transaction-id` header. signal-radar runs `search` through
`shims/twitter_x_home.py` with twitter-cli's own Python, which initialises that
header from the logged-in `x.com/home` page instead (the same fix used in
[figma-navi-video#162](https://github.com/nannantown/figma-navi-video/pull/162)).
Nothing on disk is patched. If a twitter-cli upgrade renames the internals the
shim patches, it prints a warning and runs twitter-cli unpatched instead of
crashing. If search still fails you get
`x_search_unavailable`; `feed`, `@handle` and `list:<id>` don't need the
header. Heavy use can trigger `x_rate_limited`; wait ~15 minutes.

### TikTok errors

The TikTok lane first asks `opencli auth status --site tiktok`. If opencli says
the Chrome profile is not logged in, the run fails with `tiktok_auth` instead of
silently returning nothing. A query page with no videos is reported as
`! skipped <term>: tiktok_no_results`.

## Commands

```bash
signal-radar x                         # your home feed
signal-radar x @karpathy list:123      # user posts, lists
signal-radar tiktok "ai gadget" "#airpods"
signal-radar creators                  # shortlist authors of top posts
signal-radar mail ~/export.json        # sort a Gmail JSON export
```

Flags: `--top N` (how many top items grok enriches and delivers, default
`10`), `--dry` (write the digest, deliver nothing), `--json` (print counts as
JSON), `--home <dir>` (data dir). Everything — `radar.db`, `<date>.html`,
`digest.md`, `outbox/` — lives in `~/.signal-radar` unless you set
`SIGNAL_RADAR_HOME` or `--home`. The long form `signal-radar run --lane x
--queries a,b --enrich-top N [--db] [--out] [--mail-file]` still works.

## Tests

```bash
npm test              # stubbed runners only, no network/API calls
LIVE=1 npm test        # also runs the opt-in suites against real jev/grok
```

## Schedule (pi-schedule-prompt)

`pi-schedule-prompt` is a pi extension whose `schedule_prompt` tool injects a
prompt into a pi session on a cron/interval/relative schedule; it does not
run shell commands directly, so the scheduled prompt below is a natural-
language instruction for the pi agent to execute (verified against the
installed package's README via `npm view pi-schedule-prompt readme`; the
exact wording of the prompt text itself is not a documented API and is
illustrative):

```
schedule "run the signal-radar X lane, then forward any new files under
~/.signal-radar/outbox/ to Telegram and delete each one after
forwarding" every 3 hours
```

which the agent turns into a `schedule_prompt` tool call along the lines of
`{ action: "add", type: "interval", schedule: "3h", prompt: "..." }`.

## Costs (measured 2026-09-24)

- `jev ask` — roughly $0.00003–$0.00006 per judgment call (orchestrator
  ledger).
- `grok` enrich — about 30k input tokens per call. Logged in with an xAI
  membership (`grok` login), calls count against your plan's usage limits,
  not money; at API prices it would be roughly $0.021 per enriched item. This is why `--enrich-top` defaults to 10, and why an
  item that already has an `enrich_json` row is never sent to grok again.
- A live run over 50 real X feed posts ranked genuine AI launches around
  0.5–0.7 and scams/ads/engagement-bait around 0.00–0.01.

## Safety

- Read-only everywhere: no post, reply, like, follow, retweet, bookmark, or
  delete calls anywhere in `src/`. `test/readonly.test.ts` statically scans
  every source file for write-side CLI subcommands/flags and HTTP
  POST/PUT/DELETE calls and fails the suite if any appear.
- `grok` runs headless with `--tools ''` and `--disable-web-search`, from the
  temp directory (so no project skills load) — no tool use, no web access, no
  write actions. Answers that are empty or `"placeholder"` are rejected, so an
  item whose caption names no product simply gets no enrichment.
- All scraped/emailed text is wrapped in a delimited data block and the prompt
  tells jev/grok to treat it as untrusted data. For grok the delimiter is
  nonce-tagged and neutralised; the mail rubric escapes `<`/`>`; the
  x/tiktok/creators rubrics turn any run of `---` in scraped text or handles
  into an em dash, so a post cannot fake the end of its data block.
- No auto-DM, auto-reply, or auto-follow. The creators lane only aggregates
  and scores authors of X and TikTok posts scored in the last 7 days
  (delivered or not); nothing here contacts anyone.
