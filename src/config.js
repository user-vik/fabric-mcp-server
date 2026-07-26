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
  VERSION,
  WRITE_ENABLED,
};
