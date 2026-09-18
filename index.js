#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { normalizeOneLakeFilePath } from "./src/fabric/files.js";
import { readResponseBytes } from "./src/http/client.js";
import { pollJobInstance, pollLro } from "./src/http/polling.js";
import { startServer } from "./src/server.js";
import { READ_TOOLS, TOOLS, WRITE_TOOLS, getTool } from "./src/tools/index.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}

export { READ_TOOLS, TOOLS, WRITE_TOOLS, getTool, normalizeOneLakeFilePath, pollJobInstance, pollLro, readResponseBytes };
