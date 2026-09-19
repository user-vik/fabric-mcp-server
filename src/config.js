import { readFileSync } from "node:fs";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const VERSION = PACKAGE.version;
const FABRIC_BASE = "https://api.fabric.microsoft.com/v1";
const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";
const PBI_BASE = "https://api.powerbi.com/v1.0/myorg";
const PBI_SCOPE = "https://analysis.windows.net/powerbi/api/.default";
const ONELAKE_BASE = "https://onelake.dfs.fabric.microsoft.com";
const STORAGE_SCOPE = "https://storage.azure.com/.default";
const MAX_RETRIES = 3;
const RETRY_MAX_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const LRO_MAX_WAIT_MS = 300_000;
const WRITE_ENABLED = (process.env.FABRIC_MCP_MODE ?? "read").toLowerCase() === "write";

// Token cache: "memory" (default for the MCP server, which lives for the whole
// session) or "persistent" (default for the CLI, where each command is a fresh
// process and would otherwise re-prompt for sign-in).
const TOKEN_CACHE_PERSISTENT = ["persistent", "true", "1"].includes((process.env.FABRIC_TOKEN_CACHE ?? "memory").toLowerCase());
const TOKEN_CACHE_NAME = process.env.FABRIC_TOKEN_CACHE_NAME || "fabric-mcp-server";

export {
  FABRIC_BASE,
  FABRIC_SCOPE,
  LRO_MAX_WAIT_MS,
  MAX_RETRIES,
  ONELAKE_BASE,
  PBI_BASE,
  PBI_SCOPE,
  REQUEST_TIMEOUT_MS,
  RETRY_MAX_DELAY_MS,
  STORAGE_SCOPE,
  TOKEN_CACHE_NAME,
  TOKEN_CACHE_PERSISTENT,
  VERSION,
  WRITE_ENABLED,
};
