#!/usr/bin/env node
// CLI entry point. A fresh process per command, so default to the persistent
// token cache unless the caller chose otherwise.
process.env.FABRIC_TOKEN_CACHE ??= "persistent";

try {
  const { runCli } = await import("../src/cli/main.js");
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  // Anything that escaped runCli is a bug or an environment failure, not a tool
  // error: report the message without a stack trace and exit non-zero.
  console.error(`[fabric] unexpected error: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
