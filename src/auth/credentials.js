import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AzureCliCredential,
  AzurePowerShellCredential,
  ClientSecretCredential,
  DefaultAzureCredential,
  DeviceCodeCredential,
  InteractiveBrowserCredential,
  ManagedIdentityCredential,
  deserializeAuthenticationRecord,
  serializeAuthenticationRecord,
  useIdentityPlugin,
} from "@azure/identity";
import { FABRIC_SCOPE, TOKEN_CACHE_NAME, TOKEN_CACHE_PERSISTENT } from "../config.js";

const AUTH_MODES = [
  "interactive",
  "device-code",
  "cli",
  "azure-powershell",
  "service-principal",
  "managed-identity",
  "default",
];
const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
// Only these modes produce an AuthenticationRecord and benefit from the
// persistent user-token cache. Service principals cache by client id already.
const RECORD_MODES = new Set(["interactive", "device-code"]);

let credential;
let persistencePluginState = "unloaded"; // unloaded | loaded | unavailable

function requireEnv(value, name, mode) {
  if (!value) {
    console.error(`FABRIC_AUTH_MODE=${mode} requires ${name}`);
    process.exit(1);
  }
  return value;
}

function authMode() {
  return (process.env.FABRIC_AUTH_MODE || "interactive").toLowerCase();
}

/**
 * Register the persistent token cache plugin (DPAPI on Windows, Keychain on
 * macOS, libsecret on Linux). Only needed when a short-lived process (the CLI)
 * must reuse a sign-in from a previous process; the long-lived MCP server holds
 * its token in memory. Best effort: if the native module fails to load we fall
 * back to the in-memory cache and say so on stderr.
 */
async function enableTokenCachePersistence() {
  if (persistencePluginState !== "unloaded") return persistencePluginState === "loaded";
  try {
    const { cachePersistencePlugin } = await import("@azure/identity-cache-persistence");
    useIdentityPlugin(cachePersistencePlugin);
    persistencePluginState = "loaded";
  } catch (error) {
    persistencePluginState = "unavailable";
    console.error(`[fabric-mcp] persistent token cache unavailable (${error.message}); using in-memory cache`);
  }
  return persistencePluginState === "loaded";
}

function cacheOptions() {
  if (persistencePluginState !== "loaded") return {};
  return { tokenCachePersistenceOptions: { enabled: true, name: TOKEN_CACHE_NAME } };
}

/**
 * The persistent MSAL cache holds the tokens, but @azure/identity only looks a
 * user account up in it when the credential is constructed with that account's
 * AuthenticationRecord (otherwise every new process goes straight to the
 * browser). The record is not a secret — tenant, client, home account id,
 * username, authority — so it lives as plain JSON under the user profile,
 * keyed by mode + tenant + client so different sign-ins never collide.
 */
function authRecordPath({ mode = authMode(), tenantId = process.env.AZURE_TENANT_ID, clientId = process.env.AZURE_CLIENT_ID } = {}) {
  const dir = process.env.FABRIC_AUTH_RECORD_DIR || join(homedir(), ".fabric-mcp-server");
  const safe = (value) => String(value ?? "default").replace(/[^a-z0-9-]/gi, "_");
  return join(dir, `${safe(TOKEN_CACHE_NAME)}.${safe(mode)}.${safe(tenantId)}.${safe(clientId || AZURE_CLI_CLIENT_ID)}.auth-record.json`);
}

function readAuthRecord(path) {
  try {
    if (!existsSync(path)) return null;
    return deserializeAuthenticationRecord(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`[fabric-mcp] ignoring unreadable auth record ${path}: ${error.message}`);
    return null;
  }
}

function writeAuthRecord(path, record) {
  const serialized = serializeAuthenticationRecord(record);
  try {
    if (existsSync(path) && readFileSync(path, "utf8") === serialized) return false;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch (error) {
    console.error(`[fabric-mcp] could not save auth record ${path}: ${error.message}`);
    return false;
  }
}

function buildCredential({ authenticationRecord } = {}) {
  const mode = authMode();
  if (!AUTH_MODES.includes(mode)) {
    console.error(`Invalid FABRIC_AUTH_MODE "${mode}". Valid: ${AUTH_MODES.join(", ")}`);
    process.exit(1);
  }
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const record = authenticationRecord ? { authenticationRecord } : {};

  switch (mode) {
    case "interactive":
      return new InteractiveBrowserCredential({
        tenantId: requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        clientId: clientId || AZURE_CLI_CLIENT_ID,
        ...cacheOptions(),
        ...record,
      });
    case "device-code":
      return new DeviceCodeCredential({
        tenantId: requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        clientId: clientId || AZURE_CLI_CLIENT_ID,
        userPromptCallback: (info) => {
          console.error(`[fabric-mcp] ${info.message}`);
        },
        ...cacheOptions(),
        ...record,
      });
    case "cli":
      return new AzureCliCredential(tenantId ? { tenantId } : undefined);
    case "azure-powershell":
      return new AzurePowerShellCredential(tenantId ? { tenantId } : undefined);
    case "service-principal":
      return new ClientSecretCredential(
        requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        requireEnv(clientId, "AZURE_CLIENT_ID", mode),
        requireEnv(clientSecret, "AZURE_CLIENT_SECRET", mode),
        cacheOptions(),
      );
    case "managed-identity":
      return new ManagedIdentityCredential(clientId ? { clientId } : undefined);
    case "default":
      return new DefaultAzureCredential(tenantId ? { tenantId } : undefined);
  }
}

async function getToken(scope = FABRIC_SCOPE) {
  const cred = credential ?? (await initializeCredential());
  const token = await cred.getToken(scope);
  return token.token;
}

let initPromise;

/**
 * Build the credential exactly once per process. Concurrent first callers
 * (e.g. two API requests fired with Promise.all before any token exists) share
 * the same in-flight initialization, so an interactive sign-in can never be
 * prompted twice. A failed initialization is not cached, so the next call
 * retries.
 */
function initializeCredential() {
  if (!initPromise) {
    initPromise = doInitialize().catch((error) => {
      initPromise = undefined;
      throw error;
    });
  }
  return initPromise;
}

async function doInitialize() {
  const persistent = TOKEN_CACHE_PERSISTENT && (await enableTokenCachePersistence());
  const useRecord = persistent && RECORD_MODES.has(authMode());
  const recordPath = useRecord ? authRecordPath() : null;
  const built = buildCredential({ authenticationRecord: useRecord ? readAuthRecord(recordPath) : undefined });
  if (useRecord && typeof built.authenticate === "function") {
    // Silent when the record + cached refresh token are valid; interactive only
    // on first use or after the cached account went stale. Either way the
    // returned record is the current one, so persist it for the next process.
    const record = await built.authenticate(FABRIC_SCOPE);
    if (record && writeAuthRecord(recordPath, record)) {
      console.error(`[fabric-mcp] signed in as ${record.username}; auth record saved to ${recordPath}`);
    }
  }
  credential = built;
  return credential;
}

export { authRecordPath, buildCredential, enableTokenCachePersistence, getToken, initializeCredential };
