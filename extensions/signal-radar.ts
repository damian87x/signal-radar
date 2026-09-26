/**
 * signal-radar for pi: a `signal_radar` tool the agent can call, and a `/radar` command.
 * Both run the bundled CLI (bin/signal-radar.mjs) so pi and the terminal share one code path
 * and one data dir (~/.signal-radar, or $SIGNAL_RADAR_HOME).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HERE = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "signal-radar.mjs");
const TIMEOUT_MS = 15 * 60_000;

export default function (pi: ExtensionAPI) {
  const radar = (argv: string[], cwd: string) =>
    pi.exec(process.execPath, [BIN, ...argv], { cwd, timeout: TIMEOUT_MS });

  pi.registerTool({
    name: "signal_radar",
    label: "Signal radar",
    description:
      "Scan X, TikTok, creators or an email export (read-only). Jev scores every item, Grok explains the top ones, " +
      "and a digest is written to ~/.signal-radar (<date>.html, digest.md). Non-dry runs also write one new " +
      "~/.signal-radar/outbox/*.md file per delivery, ready to forward (e.g. to Telegram) and then delete.",
    parameters: Type.Object({
      lane: Type.Union([Type.Literal("x"), Type.Literal("tiktok"), Type.Literal("creators"), Type.Literal("mail")]),
      sources: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "x: 'feed' (default), '@handle', 'list:<id>', or search text. tiktok: search terms or #hashtags. mail: [path to JSON export].",
        }),
      ),
      top: Type.Optional(Type.Number({ description: "How many top items Grok enriches and delivers (default 10)." })),
      dry: Type.Optional(Type.Boolean({ description: "Write the digest but deliver nothing." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const argv = [params.lane, ...(params.sources ?? [])];
      if (params.top) argv.push("--top", String(params.top));
      if (params.dry) argv.push("--dry");
      const r = await radar(argv, ctx.cwd);
      const text = (r.stdout || r.stderr || "").trim() || `signal-radar exited ${r.code}`;
      return { content: [{ type: "text", text }], details: { code: r.code } };
    },
  });

  pi.registerCommand("radar", {
    description: "Signal radar: /radar x [@handle ...] | tiktok <terms> | creators | mail <file> [--top N] [--dry]",
    handler: async (args, ctx) => {
      const argv = (args || "").trim() ? (args as string).trim().split(/\s+/) : ["x"];
      const r = await radar(argv, ctx.cwd);
      ctx.ui.notify((r.stdout || r.stderr || `exit ${r.code}`).trim().slice(0, 4000), r.code === 0 ? "info" : "warning");
    },
  });
}
