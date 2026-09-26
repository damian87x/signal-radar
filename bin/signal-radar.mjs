#!/usr/bin/env node
// Global entry point: loads the TypeScript sources through tsx, resolved next to this file,
// so `signal-radar` works from any directory.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/cli.ts");
process.exit(await main(process.argv.slice(2)));
