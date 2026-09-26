import { describe, expect, it } from "vitest";
import extension from "../extensions/signal-radar.ts";

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
}

function fakePi() {
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const calls: Call[] = [];
  const pi = {
    registerTool: (t: any) => (tools[t.name] = t),
    registerCommand: (name: string, c: any) => (commands[name] = c),
    exec: async (cmd: string, args: string[], opts: { cwd: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { code: 0, stdout: "✓ 3 fetched · 3 new · 1 enriched · 0 delivered", stderr: "" };
    },
  };
  extension(pi as any);
  return { tools, commands, calls };
}

describe("pi extension", () => {
  it("registers the signal_radar tool and /radar command", () => {
    const { tools, commands } = fakePi();
    expect(Object.keys(tools)).toEqual(["signal_radar"]);
    expect(Object.keys(commands)).toEqual(["radar"]);
  });

  it("tool runs the bundled CLI with lane, sources, --top and --dry", async () => {
    const { tools, calls } = fakePi();
    const res = await tools.signal_radar.execute(
      "id",
      { lane: "x", sources: ["@karpathy", "feed"], top: 3, dry: true },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
    expect(calls[0].cmd).toBe(process.execPath);
    expect(calls[0].args[0]).toMatch(/bin[\\/]signal-radar\.mjs$/);
    expect(calls[0].args.slice(1)).toEqual(["x", "@karpathy", "feed", "--top", "3", "--dry"]);
    expect(res.content[0].text).toContain("3 fetched");
  });

  it("/radar with no args scans the X feed and notifies the result", async () => {
    const { commands, calls } = fakePi();
    const notes: string[] = [];
    await commands.radar.handler("", { cwd: "/tmp", ui: { notify: (m: string) => notes.push(m) } });
    expect(calls[0].args.slice(1)).toEqual(["x"]);
    expect(notes[0]).toContain("3 fetched");
  });
});
