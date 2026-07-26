#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { normalizeOneLakeFilePath } from "./src/fabric/files.js";
import { readResponseBytes } from "./src/http/client.js";
import { pollJobInstance, pollLro } from "./src/http/polling.js";
import { startServer } from "./src/server.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}

export { normalizeOneLakeFilePath, pollJobInstance, pollLro, readResponseBytes };
