#!/usr/bin/env node
// CLI entry point. A fresh process per command, so default to the persistent
// token cache unless the caller chose otherwise.
process.env.FABRIC_TOKEN_CACHE ??= "persistent";

const { runCli } = await import("../src/cli/main.js");
process.exitCode = await runCli(process.argv.slice(2));
