#!/usr/bin/env node
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AzureCliCredential,
  ClientSecretCredential,
  DefaultAzureCredential,
  DeviceCodeCredential,
  InteractiveBrowserCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import { z } from "zod";

// Single source of truth for the server version — keeps package.json and the
// MCP server identity in sync without manual edits.
const PACKAGE = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const VERSION = PACKAGE.version;

const AUTH_MODES = [
  "interactive",
  "device-code",
  "cli",
  "service-principal",
  "managed-identity",
  "default",
];
// Public Azure CLI client ID — safe default for user-flow modes only.
const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

function requireEnv(value, name, mode) {
  if (!value) {
    console.error(`FABRIC_AUTH_MODE=${mode} requires ${name}`);
    process.exit(1);
  }
  return value;
}

function buildCredential() {
  const mode = (process.env.FABRIC_AUTH_MODE || "interactive").toLowerCase();
  if (!AUTH_MODES.includes(mode)) {
    console.error(`Invalid FABRIC_AUTH_MODE "${mode}". Valid: ${AUTH_MODES.join(", ")}`);
    process.exit(1);
  }
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  switch (mode) {
    case "interactive":
      return new InteractiveBrowserCredential({
        tenantId: requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        clientId: clientId || AZURE_CLI_CLIENT_ID,
      });
    case "device-code":
      return new DeviceCodeCredential({
        tenantId: requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        clientId: clientId || AZURE_CLI_CLIENT_ID,
        // Default callback writes to stdout, which would corrupt the MCP
        // protocol stream. Redirect to stderr so the MCP client logs it.
        userPromptCallback: (info) => {
          console.error(`[fabric-mcp] ${info.message}`);
        },
      });
    case "cli":
      return new AzureCliCredential(tenantId ? { tenantId } : undefined);
    case "service-principal":
      return new ClientSecretCredential(
        requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        requireEnv(clientId, "AZURE_CLIENT_ID", mode),
        requireEnv(clientSecret, "AZURE_CLIENT_SECRET", mode),
      );
    case "managed-identity":
      return new ManagedIdentityCredential(clientId ? { clientId } : undefined);
    case "default":
      return new DefaultAzureCredential(tenantId ? { tenantId } : undefined);
  }
}

const credential = buildCredential();
const FABRIC_BASE = "https://api.fabric.microsoft.com/v1";
const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";
// Power BI REST — used for semantic-model DAX (executeQueries). Different host
// and token audience than the Fabric API; the workspace GUID doubles as the
// Power BI groupId.
const PBI_BASE = "https://api.powerbi.com/v1.0/myorg";
const PBI_SCOPE = "https://analysis.windows.net/powerbi/api/.default";
// OneLake DFS (onelake.dfs.fabric.microsoft.com) — lag-free file/table listing
// and small-file reads straight from OneLake. Uses the Azure Storage token
// audience (not the Fabric API audience) and addresses items by GUID.
const ONELAKE_BASE = "https://onelake.dfs.fabric.microsoft.com";
const STORAGE_SCOPE = "https://storage.azure.com/.default";
const MAX_RETRIES = 3;
const RETRY_MAX_DELAY_MS = 60_000;
// Fabric getDefinition/updateDefinition are long-running operations; cap how
// long we poll before giving up.
const LRO_MAX_WAIT_MS = 300_000;

async function getToken(scope = FABRIC_SCOPE) {
  const t = await credential.getToken(scope);
  return t.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Core REST call against a Microsoft API (Fabric or Power BI). Retries on HTTP
// 429 honoring Retry-After. Returns parsed JSON (or {} for empty body).
async function apiRequest(base, scope, method, path, body, extraQuery = {}) {
  const token = await getToken(scope);
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(extraQuery)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const backoffMs = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
        : Math.min(2 ** attempt * 500, RETRY_MAX_DELAY_MS);
      console.error(
        `[fabric-mcp] 429 throttled on ${method} ${path}; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(backoffMs);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    // 202 Accepted (long-running ops) carries useful headers but often no body
    // (or a literal `null`), so coerce non-object payloads to a plain object
    // before stamping operation metadata onto it.
    const parsed = text ? JSON.parse(text) : {};
    const result = parsed && typeof parsed === "object" ? parsed : { value: parsed };
    if (res.status === 202) {
      result._accepted = true;
      result._location = res.headers.get("location") ?? undefined;
      result._retryAfter = res.headers.get("retry-after") ?? undefined;
    }
    return result;
  }
}

// Fabric REST (api.fabric.microsoft.com/v1). Relative path, e.g. "/workspaces".
async function fabric(method, path, body, extraQuery = {}) {
  return apiRequest(FABRIC_BASE, FABRIC_SCOPE, method, path, body, extraQuery);
}

// Power BI REST (api.powerbi.com/v1.0/myorg), e.g.
// "/groups/{id}/datasets/{id}/executeQueries".
async function powerbi(method, path, body, extraQuery = {}) {
  return apiRequest(PBI_BASE, PBI_SCOPE, method, path, body, extraQuery);
}

// OneLake DFS call. Returns parsed JSON by default, or the raw response text
// when `raw` is set (file reads). Uses the Storage audience token and retries
// 429 honoring Retry-After, like apiRequest.
async function onelake(method, path, { query = {}, raw = false } = {}) {
  const token = await getToken(STORAGE_SCOPE);
  const url = new URL(`${ONELAKE_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const backoffMs = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
        : Math.min(2 ** attempt * 500, RETRY_MAX_DELAY_MS);
      await sleep(backoffMs);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    if (raw) return text;
    return text ? JSON.parse(text) : {};
  }
}

// Polls a Fabric long-running operation (absolute status URL from a 202
// Location header) to completion. Returns the operation's result body, or the
// final status if there is no separate result. Throws on Failed/timeout.
async function pollLro(opUrl, retryAfterSec) {
  const started = Date.now();
  let delay = Math.max((retryAfterSec ?? 1) * 1000, 1000);
  while (Date.now() - started < LRO_MAX_WAIT_MS) {
    await sleep(delay);
    const token = await getToken(FABRIC_SCOPE);
    const res = await fetch(opUrl, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await res.text();
    const state = (text ? JSON.parse(text) : {}) ?? {};
    const status = (state.status ?? "").toLowerCase();
    if (status === "failed") {
      throw new Error(`Fabric operation failed: ${JSON.stringify(state.error ?? state)}`);
    }
    if (status === "succeeded") {
      const resultLoc = res.headers.get("location") ?? `${opUrl}/result`;
      const rr = await fetch(resultLoc, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (rr.ok) {
        const rt = await rr.text();
        return rt ? JSON.parse(rt) : {};
      }
      return state;
    }
    const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
    if (Number.isFinite(ra)) delay = Math.max(ra * 1000, 1000);
  }
  throw new Error(`Fabric operation timed out after ${LRO_MAX_WAIT_MS}ms: ${opUrl}`);
}

// Runs a Fabric call that may complete synchronously (200) or as an LRO (202 +
// Location). Returns the final result body either way.
async function fabricLro(method, path, body) {
  const res = await fabric(method, path, body);
  if (res && res._accepted && res._location) {
    const ra = res._retryAfter ? parseInt(res._retryAfter, 10) : undefined;
    return await pollLro(res._location, ra);
  }
  return res;
}

// Polls a Fabric job instance (absolute URL from a jobs/instances 202 Location)
// until it reaches a terminal status, then returns the final job-instance body.
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "deduped"]);
async function pollJobInstance(instanceUrl, retryAfterSec) {
  const started = Date.now();
  let delay = Math.max((retryAfterSec ?? 2) * 1000, 2000);
  while (Date.now() - started < LRO_MAX_WAIT_MS) {
    await sleep(delay);
    const token = await getToken(FABRIC_SCOPE);
    const res = await fetch(instanceUrl, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await res.text();
    const state = (text ? JSON.parse(text) : {}) ?? {};
    if (TERMINAL_JOB_STATUSES.has((state.status ?? "").toLowerCase())) return state;
    const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
    if (Number.isFinite(ra)) delay = Math.max(ra * 1000, 2000);
  }
  throw new Error(
    `Job instance did not reach a terminal status within ${LRO_MAX_WAIT_MS}ms: ${instanceUrl}`,
  );
}

// Walks Fabric's continuationToken paging for a list endpoint, accumulating
// `value` arrays up to `cap` items so a chatty workspace can't blow context.
async function fabricListAll(path, valueKey = "value", cap = 500) {
  const items = [];
  let token = null;
  do {
    const data = await fabric("GET", path, null, token ? { continuationToken: token } : {});
    for (const v of data[valueKey] ?? []) items.push(v);
    token = data.continuationToken ?? null;
  } while (token && items.length < cap);
  return items;
}

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// Wraps a tool handler so a thrown error returns as a structured MCP tool
// error the model can read, rather than a protocol-level failure.
function safeTool(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      return { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true };
    }
  };
}

// ─── Name → GUID resolution ─────────────────────────────────────────────────
// Fabric REST is GUID-addressed, but humans think in names ("30-Prod",
// "gld_pl_master"). These resolvers accept either a GUID or a display name and
// cache the lookups for the life of the process.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wsCache = new Map(); // name(lower) -> {id, displayName}

async function resolveWorkspace(workspace) {
  if (!workspace) throw new Error("workspace is required (display name or GUID)");
  if (GUID_RE.test(workspace)) return { id: workspace, displayName: undefined };
  const key = workspace.toLowerCase();
  if (wsCache.has(key)) return wsCache.get(key);
  const all = await fabricListAll("/workspaces");
  for (const w of all) wsCache.set((w.displayName ?? "").toLowerCase(), { id: w.id, displayName: w.displayName });
  const hit = wsCache.get(key);
  if (!hit) {
    const names = all.map((w) => w.displayName).filter(Boolean);
    throw new Error(`Workspace "${workspace}" not found. Available: ${names.join(", ") || "(none)"}`);
  }
  return hit;
}

// pipeline cache keyed by `${workspaceId}/${name.toLowerCase()}`
const pipeCache = new Map();

async function resolvePipeline(workspaceId, pipeline) {
  if (!pipeline) throw new Error("pipeline is required (display name or GUID)");
  if (GUID_RE.test(pipeline)) return { id: pipeline, displayName: undefined };
  const key = `${workspaceId}/${pipeline.toLowerCase()}`;
  if (pipeCache.has(key)) return pipeCache.get(key);
  const items = await fabricListAll(`/workspaces/${workspaceId}/items?type=DataPipeline`);
  for (const it of items)
    pipeCache.set(`${workspaceId}/${(it.displayName ?? "").toLowerCase()}`, {
      id: it.id,
      displayName: it.displayName,
    });
  const hit = pipeCache.get(key);
  if (!hit) {
    const names = items.map((i) => i.displayName).filter(Boolean);
    throw new Error(
      `Data pipeline "${pipeline}" not found in workspace. Available: ${names.join(", ") || "(none)"}`,
    );
  }
  return hit;
}

// semantic-model cache keyed by `${workspaceId}/${name.toLowerCase()}`
const smCache = new Map();

async function resolveDataset(workspaceId, dataset) {
  if (!dataset) throw new Error("dataset is required (semantic model display name or GUID)");
  if (GUID_RE.test(dataset)) return { id: dataset, displayName: undefined };
  const key = `${workspaceId}/${dataset.toLowerCase()}`;
  if (smCache.has(key)) return smCache.get(key);
  const items = await fabricListAll(`/workspaces/${workspaceId}/items?type=SemanticModel`);
  for (const it of items)
    smCache.set(`${workspaceId}/${(it.displayName ?? "").toLowerCase()}`, {
      id: it.id,
      displayName: it.displayName,
    });
  const hit = smCache.get(key);
  if (!hit) {
    const names = items.map((i) => i.displayName).filter(Boolean);
    throw new Error(
      `Semantic model "${dataset}" not found in workspace. Available: ${names.join(", ") || "(none)"}`,
    );
  }
  return hit;
}

// Resolve any Fabric item by display name or GUID, optionally narrowed by type.
// Errors on ambiguous names so a definition write can't hit the wrong item.
const itemCache = new Map(); // `${wsId}/${type||'*'}/${name}` -> {id, displayName, type}

async function resolveItem(workspaceId, item, type) {
  if (!item) throw new Error("item is required (display name or GUID)");
  if (GUID_RE.test(item)) return { id: item, displayName: undefined, type };
  const key = `${workspaceId}/${(type ?? "*").toLowerCase()}/${item.toLowerCase()}`;
  if (itemCache.has(key)) return itemCache.get(key);
  const path = `/workspaces/${workspaceId}/items${type ? `?type=${encodeURIComponent(type)}` : ""}`;
  const items = await fabricListAll(path);
  const matches = items.filter((i) => (i.displayName ?? "").toLowerCase() === item.toLowerCase());
  if (matches.length === 0) {
    const names = items.map((i) => i.displayName).filter(Boolean);
    throw new Error(
      `Item "${item}"${type ? ` of type ${type}` : ""} not found in workspace. Available: ${names.slice(0, 50).join(", ") || "(none)"}`,
    );
  }
  if (matches.length > 1) {
    const types = [...new Set(matches.map((m) => m.type))];
    throw new Error(
      `Item "${item}" is ambiguous (${matches.length} matches, types: ${types.join(", ")}). Pass type to disambiguate or use the GUID.`,
    );
  }
  const hit = { id: matches[0].id, displayName: matches[0].displayName, type: matches[0].type };
  itemCache.set(key, hit);
  return hit;
}

// deployment-pipeline cache: name(lower) -> {id, displayName}. Deployment
// pipelines are tenant-level (under /deploymentPipelines, not a workspace).
const deployPipeCache = new Map();

async function resolveDeploymentPipeline(pipeline) {
  if (!pipeline) throw new Error("deployment_pipeline is required (display name or GUID)");
  if (GUID_RE.test(pipeline)) return { id: pipeline, displayName: undefined };
  const key = pipeline.toLowerCase();
  if (deployPipeCache.has(key)) return deployPipeCache.get(key);
  const all = await fabricListAll("/deploymentPipelines");
  for (const p of all)
    deployPipeCache.set((p.displayName ?? "").toLowerCase(), { id: p.id, displayName: p.displayName });
  const hit = deployPipeCache.get(key);
  if (!hit) {
    const names = all.map((p) => p.displayName).filter(Boolean);
    throw new Error(
      `Deployment pipeline "${pipeline}" not found. Available: ${names.join(", ") || "(none)"}`,
    );
  }
  return hit;
}

// ─── Item-definition file helpers ───────────────────────────────────────────
// A Fabric item definition is a set of parts (files). On disk it's the folder
// Git sync produces: a `.platform` manifest plus a `definition/` subtree.
function collectFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else out.push(full);
  }
  return out;
}

function readDefinitionFromDir(dir) {
  if (!existsSync(dir)) throw new Error(`definition_path does not exist: ${dir}`);
  const files = collectFiles(dir);
  if (!files.some((f) => f.endsWith(".platform"))) {
    throw new Error(
      `No .platform file found under ${dir} — this does not look like a Fabric item definition folder. Point definition_path at the item folder (the one containing .platform and definition/).`,
    );
  }
  return {
    parts: files.map((f) => ({
      path: relative(dir, f).split(sep).join("/"),
      payload: readFileSync(f).toString("base64"),
      payloadType: "InlineBase64",
    })),
  };
}

function snapshotDir() {
  const d = join(tmpdir(), "fabric-mcp-snapshots");
  mkdirSync(d, { recursive: true });
  return d;
}

function writeSnapshot(itemId, definition) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(snapshotDir(), `${itemId}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(definition, null, 2), "utf8");
  return file;
}

function readSnapshot(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (parsed.parts) return parsed;
  if (parsed.definition?.parts) return parsed.definition;
  throw new Error(`Snapshot file ${file} has no parts.`);
}

function summarizeRun(r) {
  return {
    jobInstanceId: r.id,
    status: r.status,
    invokeType: r.invokeType,
    jobType: r.jobType,
    startTimeUtc: r.startTimeUtc,
    endTimeUtc: r.endTimeUtc,
    durationSec:
      r.startTimeUtc && r.endTimeUtc
        ? Math.round((new Date(r.endTimeUtc) - new Date(r.startTimeUtc)) / 1000)
        : null,
    failureReason: r.failureReason ?? null,
    rootActivityId: r.rootActivityId,
  };
}

// ─── Write-mode gating ──────────────────────────────────────────────────────
const WRITE_ENABLED = (process.env.FABRIC_MCP_MODE ?? "read").toLowerCase() === "write";
if (WRITE_ENABLED) {
  console.error(
    "[fabric-mcp] write mode enabled — run_pipeline, cancel_pipeline_run, refresh_dataset, update_from_git, update_item_definition, create_schedule, update_schedule, delete_schedule, deploy_stage, run_notebook, create_item, delete_item, add_workspace_role exposed",
  );
}

const server = new McpServer({ name: "fabric-mcp", version: VERSION });

server.registerTool(
  "list_workspaces",
  {
    description: "List all Microsoft Fabric workspaces the signed-in identity can see.",
    inputSchema: {},
  },
  safeTool(async () => {
    const all = await fabricListAll("/workspaces");
    return ok(all.map((w) => ({ id: w.id, displayName: w.displayName, capacityId: w.capacityId })));
  }),
);

server.registerTool(
  "list_pipelines",
  {
    description:
      "List the data pipelines in a Fabric workspace. Accepts a workspace display name (e.g. \"My-Workspace\") or GUID.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
    },
  },
  safeTool(async ({ workspace }) => {
    const ws = await resolveWorkspace(workspace);
    const items = await fabricListAll(`/workspaces/${ws.id}/items?type=DataPipeline`);
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      pipelines: items.map((i) => ({ id: i.id, displayName: i.displayName, description: i.description })),
    });
  }),
);

server.registerTool(
  "list_pipeline_runs",
  {
    description:
      "List run (job instance) history for a Fabric data pipeline, most-recent first. Accepts workspace + pipeline by display name or GUID. Use this for 'how did my pipeline run last night' style questions.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
      pipeline: z.string().describe("Data pipeline display name or GUID"),
      status: z
        .string()
        .optional()
        .describe("Client-side filter on status, e.g. Completed, Failed, InProgress, Cancelled"),
      top: z.number().int().positive().max(200).optional().describe("Max runs to return (default 25)"),
    },
  },
  safeTool(async ({ workspace, pipeline, status, top }) => {
    const ws = await resolveWorkspace(workspace);
    const pl = await resolvePipeline(ws.id, pipeline);
    const runs = await fabricListAll(`/workspaces/${ws.id}/items/${pl.id}/jobs/instances`);
    let mapped = runs.map(summarizeRun);
    if (status) mapped = mapped.filter((r) => (r.status ?? "").toLowerCase() === status.toLowerCase());
    mapped.sort((a, b) => new Date(b.startTimeUtc ?? 0) - new Date(a.startTimeUtc ?? 0));
    const limit = top ?? 25;
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      pipeline: { id: pl.id, displayName: pl.displayName ?? pipeline },
      returned: Math.min(limit, mapped.length),
      totalFetched: mapped.length,
      runs: mapped.slice(0, limit),
    });
  }),
);

server.registerTool(
  "get_pipeline_run",
  {
    description:
      "Get full detail for a single pipeline run (job instance) by its ID, including failureReason. Use after list_pipeline_runs to drill into a failure.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
      pipeline: z.string().describe("Data pipeline display name or GUID"),
      job_instance_id: z.string().describe("The job instance ID from list_pipeline_runs"),
    },
  },
  safeTool(async ({ workspace, pipeline, job_instance_id }) => {
    const ws = await resolveWorkspace(workspace);
    const pl = await resolvePipeline(ws.id, pipeline);
    const data = await fabric(
      "GET",
      `/workspaces/${ws.id}/items/${pl.id}/jobs/instances/${encodeURIComponent(job_instance_id)}`,
    );
    return ok(data);
  }),
);

server.registerTool(
  "execute_dax",
  {
    description:
      "Run a read-only DAX query against a Fabric/Power BI semantic model and return the result rows. Accepts workspace + dataset (semantic model) by display name or GUID. Use to validate measures or run ad-hoc analytics against a live model, e.g. 'EVALUATE ROW(\"x\", [Some Measure])'. Read-only: the Power BI executeQueries API rejects data-modifying DAX. Requires the caller to have Build permission on the dataset and the tenant's \"Dataset Execute Queries REST API\" setting enabled.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
      dataset: z.string().describe("Semantic model (dataset) display name or GUID"),
      dax: z.string().describe("A DAX query, e.g. starting with EVALUATE or DEFINE ... EVALUATE"),
      impersonated_user: z
        .string()
        .optional()
        .describe("Optional UPN to evaluate under for row-level security (effectiveUserName)"),
    },
  },
  safeTool(async ({ workspace, dataset, dax, impersonated_user }) => {
    const ws = await resolveWorkspace(workspace);
    const ds = await resolveDataset(ws.id, dataset);
    const body = {
      queries: [{ query: dax }],
      serializerSettings: { includeNulls: true },
    };
    if (impersonated_user) body.impersonatedUserName = impersonated_user;
    const data = await powerbi(
      "POST",
      `/groups/${ws.id}/datasets/${ds.id}/executeQueries`,
      body,
    );
    const tables = data?.results?.[0]?.tables ?? [];
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      dataset: { id: ds.id, displayName: ds.displayName ?? dataset },
      rowCount: tables[0]?.rows?.length ?? 0,
      rows: tables[0]?.rows ?? [],
      ...(tables.length > 1 ? { additionalTables: tables.slice(1) } : {}),
    });
  }),
);

server.registerTool(
  "list_items",
  {
    description:
      "List items in a Fabric workspace — notebooks, lakehouses, warehouses, semantic models, reports, data pipelines, etc. Optional type filter. Accepts workspace by display name or GUID.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
      type: z
        .string()
        .optional()
        .describe(
          "Optional item type filter, e.g. Notebook, Lakehouse, Warehouse, SemanticModel, Report, DataPipeline",
        ),
    },
  },
  safeTool(async ({ workspace, type }) => {
    const ws = await resolveWorkspace(workspace);
    const path = `/workspaces/${ws.id}/items${type ? `?type=${encodeURIComponent(type)}` : ""}`;
    const items = await fabricListAll(path);
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      ...(type ? { type } : {}),
      count: items.length,
      items: items.map((i) => ({
        id: i.id,
        type: i.type,
        displayName: i.displayName,
        description: i.description,
      })),
    });
  }),
);

server.registerTool(
  "get_refresh_history",
  {
    description:
      "Get recent refresh history for a semantic model (dataset), most-recent first — check whether a scheduled or on-demand refresh succeeded and why it failed. Accepts workspace + dataset by display name or GUID.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
      dataset: z.string().describe("Semantic model (dataset) display name or GUID"),
      top: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Max refresh entries to return (default 20)"),
    },
  },
  safeTool(async ({ workspace, dataset, top }) => {
    const ws = await resolveWorkspace(workspace);
    const ds = await resolveDataset(ws.id, dataset);
    const data = await powerbi(
      "GET",
      `/groups/${ws.id}/datasets/${ds.id}/refreshes`,
      null,
      { $top: top ?? 20 },
    );
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      dataset: { id: ds.id, displayName: ds.displayName ?? dataset },
      refreshes: data.value ?? [],
    });
  }),
);

server.registerTool(
  "get_git_status",
  {
    description:
      "Show the Git status of a Fabric workspace: items changed between the workspace and its connected Git branch, plus the remote commit hash and workspace head. Requires the workspace to be connected to Git.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
    },
  },
  safeTool(async ({ workspace }) => {
    const ws = await resolveWorkspace(workspace);
    const data = await fabric("GET", `/workspaces/${ws.id}/git/status`);
    return ok({ workspace: { id: ws.id, displayName: ws.displayName }, ...data });
  }),
);

server.registerTool(
  "get_item_definition",
  {
    description:
      "Get the definition (source parts) of a Fabric item — semantic model TMDL, notebook content, report, etc. By default returns a manifest of part paths (no payloads, to stay small); pass 'part' with a path to get that file's decoded contents. Useful for inspecting or backing up a live item before deploying. Accepts workspace + item by display name or GUID.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
      item: z.string().describe("Item display name or GUID"),
      type: z
        .string()
        .optional()
        .describe("Item type to disambiguate the name, e.g. SemanticModel, Notebook, Report"),
      format: z
        .string()
        .optional()
        .describe("Optional definition format, e.g. 'ipynb' for notebooks"),
      part: z.string().optional().describe("A part path (from the manifest) to return decoded to text"),
    },
  },
  safeTool(async ({ workspace, item, type, format, part }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const q = format ? `?format=${encodeURIComponent(format)}` : "";
    const data = await fabricLro("POST", `/workspaces/${ws.id}/items/${it.id}/getDefinition${q}`);
    const parts = data?.definition?.parts ?? [];
    const itemInfo = { id: it.id, displayName: it.displayName ?? item, type: it.type };
    if (part) {
      const p = parts.find((x) => x.path === part);
      if (!p) throw new Error(`Part "${part}" not found. Parts: ${parts.map((x) => x.path).join(", ")}`);
      const content =
        p.payloadType === "InlineBase64"
          ? Buffer.from(p.payload ?? "", "base64").toString("utf8")
          : `(non-base64 payloadType: ${p.payloadType})`;
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: itemInfo,
        part: { path: p.path, payloadType: p.payloadType, content },
      });
    }
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      item: itemInfo,
      partCount: parts.length,
      parts: parts.map((x) => ({
        path: x.path,
        payloadType: x.payloadType,
        base64Length: (x.payload ?? "").length,
      })),
      note: "Call again with 'part' set to a path to get that file's decoded contents.",
    });
  }),
);

server.registerTool(
  "list_schedules",
  {
    description:
      "List the job schedules on a Fabric item (data pipeline, notebook, ...), including each schedule's owner (id + type). Use the owner to detect ownership drift: deploying an item, or calling update_item_definition, recreates its schedules under the CALLER's identity — so a schedule you expect to be service-principal-owned can silently flip to a user. Accepts workspace + item by display name or GUID.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
      item: z.string().describe("Item display name or GUID (the pipeline/notebook the schedule runs)"),
      type: z
        .string()
        .optional()
        .describe("Item type to disambiguate the name, e.g. DataPipeline, Notebook"),
      job_type: z
        .string()
        .optional()
        .describe("Schedule job type (default 'Pipeline'; use 'RunNotebook' for notebooks)"),
    },
  },
  safeTool(async ({ workspace, item, type, job_type }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const jt = job_type ?? "Pipeline";
    const schedules = await fabricListAll(
      `/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jt)}/schedules`,
    );
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
      jobType: jt,
      schedules: schedules.map((s) => ({
        id: s.id,
        enabled: s.enabled,
        owner: s.owner ? { id: s.owner.id, type: s.owner.type } : null,
        createdDateTime: s.createdDateTime,
        configuration: s.configuration,
      })),
    });
  }),
);

server.registerTool(
  "list_deployment_pipelines",
  {
    description:
      "List the Fabric deployment pipelines the signed-in identity can see — used to promote item definitions across stages (e.g. Dev -> Test -> Prod).",
    inputSchema: {},
  },
  safeTool(async () => {
    const all = await fabricListAll("/deploymentPipelines");
    return ok(all.map((p) => ({ id: p.id, displayName: p.displayName, description: p.description })));
  }),
);

server.registerTool(
  "list_deployment_stages",
  {
    description:
      "List the stages of a Fabric deployment pipeline (order, display name, assigned workspace). Pass 'stage' to also return that stage's items — the source item IDs + types you feed to deploy_stage. Accepts the deployment pipeline (and optional stage) by display name or GUID.",
    inputSchema: {
      deployment_pipeline: z.string().describe("Deployment pipeline display name or GUID"),
      stage: z
        .string()
        .optional()
        .describe("Optional stage display name or GUID to also list that stage's items"),
    },
  },
  safeTool(async ({ deployment_pipeline, stage }) => {
    const dp = await resolveDeploymentPipeline(deployment_pipeline);
    const stages = await fabricListAll(`/deploymentPipelines/${dp.id}/stages`);
    const result = {
      deploymentPipeline: { id: dp.id, displayName: dp.displayName ?? deployment_pipeline },
      stages: stages.map((s) => ({
        id: s.id,
        order: s.order,
        displayName: s.displayName,
        workspaceId: s.workspaceId,
        workspaceName: s.workspaceName,
        isPublic: s.isPublic,
      })),
    };
    if (stage) {
      const match = stages.find((s) =>
        GUID_RE.test(stage)
          ? s.id === stage
          : (s.displayName ?? "").toLowerCase() === stage.toLowerCase(),
      );
      if (!match)
        throw new Error(
          `Stage "${stage}" not found. Stages: ${stages.map((s) => s.displayName).join(", ")}`,
        );
      const items = await fabricListAll(`/deploymentPipelines/${dp.id}/stages/${match.id}/items`);
      result.stageItems = {
        stage: { id: match.id, displayName: match.displayName },
        items: items.map((i) => ({
          sourceItemId: i.itemId,
          itemDisplayName: i.itemDisplayName,
          itemType: i.itemType,
        })),
      };
    }
    return ok(result);
  }),
);

server.registerTool(
  "list_onelake",
  {
    description:
      "List files/folders under a Fabric item in OneLake via the DFS API — lag-free ground truth for 'did this table/file land yet?' (the SQL analytics endpoint's metadata can lag minutes behind actual writes). Defaults to the item's Delta tables under the default schema. Accepts workspace + item by display name or GUID.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
      item: z.string().describe("Lakehouse/warehouse/item display name or GUID"),
      type: z.string().optional().describe("Item type to disambiguate the name, e.g. Lakehouse, Warehouse"),
      directory: z
        .string()
        .optional()
        .describe("Directory under the item to list, e.g. 'Tables/dbo' (default), 'Tables/<schema>', 'Files'"),
      recursive: z.boolean().optional().describe("Recurse into subdirectories (default false)"),
    },
  },
  safeTool(async ({ workspace, item, type, directory, recursive }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const dir = directory ?? "Tables/dbo";
    const data = await onelake("GET", `/${ws.id}`, {
      query: {
        resource: "filesystem",
        recursive: recursive ? "true" : "false",
        directory: `${it.id}/${dir}`,
      },
    });
    const paths = (data.paths ?? []).map((p) => ({
      name: p.name,
      isDirectory: p.isDirectory === "true" || p.isDirectory === true,
      contentLength: p.contentLength != null ? Number(p.contentLength) : undefined,
      lastModified: p.lastModified,
    }));
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
      directory: dir,
      count: paths.length,
      paths,
    });
  }),
);

server.registerTool(
  "read_onelake_file",
  {
    description:
      "Read a small file from a Fabric item's OneLake storage (e.g. a notebook output, log, or JSON result under Files/). Returns decoded text, capped in size. Accepts workspace + item by display name or GUID.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
      item: z.string().describe("Item display name or GUID"),
      type: z.string().optional().describe("Item type to disambiguate the name"),
      path: z.string().describe("File path under the item, e.g. 'Files/output/summary.json'"),
      max_bytes: z
        .number()
        .int()
        .positive()
        .max(1_000_000)
        .optional()
        .describe("Max characters to return (default 100000)"),
    },
  },
  safeTool(async ({ workspace, item, type, path, max_bytes }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const cap = max_bytes ?? 100_000;
    const text = await onelake("GET", `/${ws.id}/${it.id}/${path.replace(/^\/+/, "")}`, { raw: true });
    const truncated = text.length > cap;
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
      path,
      length: text.length,
      truncated,
      content: truncated ? text.slice(0, cap) : text,
    });
  }),
);

server.registerTool(
  "list_workspace_roles",
  {
    description:
      "List the role assignments on a Fabric workspace — which principals (users, groups, service principals) hold Admin/Member/Contributor/Viewer. Accepts workspace by display name or GUID.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
    },
  },
  safeTool(async ({ workspace }) => {
    const ws = await resolveWorkspace(workspace);
    const roles = await fabricListAll(`/workspaces/${ws.id}/roleAssignments`);
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      roleAssignments: roles.map((r) => ({
        id: r.id,
        role: r.role,
        principal: r.principal
          ? { id: r.principal.id, displayName: r.principal.displayName, type: r.principal.type }
          : null,
      })),
    });
  }),
);

server.registerTool(
  "list_sql_databases",
  {
    description:
      "List the SQL databases in a Fabric workspace and their connection properties (server FQDN, database name, connection string) — resolve a database's endpoint without hunting through the portal. Accepts workspace by display name or GUID; optional name filter.",
    inputSchema: {
      workspace: z.string().describe("Workspace display name or GUID"),
      name: z.string().optional().describe("Optional case-insensitive display-name filter"),
    },
  },
  safeTool(async ({ workspace, name }) => {
    const ws = await resolveWorkspace(workspace);
    let dbs = await fabricListAll(`/workspaces/${ws.id}/sqlDatabases`);
    if (name) dbs = dbs.filter((d) => (d.displayName ?? "").toLowerCase().includes(name.toLowerCase()));
    return ok({
      workspace: { id: ws.id, displayName: ws.displayName },
      count: dbs.length,
      databases: dbs.map((d) => ({
        id: d.id,
        displayName: d.displayName,
        description: d.description,
        serverFqdn: d.properties?.serverFqdn,
        databaseName: d.properties?.databaseName,
        connectionString: d.properties?.connectionString,
      })),
    });
  }),
);

if (WRITE_ENABLED) {
  server.registerTool(
    "run_pipeline",
    {
      description:
        "Trigger an on-demand run of a Fabric data pipeline. Returns the accepted operation location. Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        pipeline: z.string().describe("Data pipeline display name or GUID"),
        parameters: z
          .record(z.any())
          .optional()
          .describe("Optional executionData.parameters object passed to the pipeline"),
      },
    },
    safeTool(async ({ workspace, pipeline, parameters }) => {
      const ws = await resolveWorkspace(workspace);
      const pl = await resolvePipeline(ws.id, pipeline);
      const body = parameters ? { executionData: { parameters } } : undefined;
      const data = await fabric(
        "POST",
        `/workspaces/${ws.id}/items/${pl.id}/jobs/instances`,
        body,
        { jobType: "Pipeline" },
      );
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} run_pipeline ws=${ws.id} item=${pl.id}`,
      );
      return ok({ accepted: true, operationLocation: data._location ?? null, raw: data });
    }),
  );

  server.registerTool(
    "cancel_pipeline_run",
    {
      description:
        "Cancel an in-progress pipeline run (job instance). Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        pipeline: z.string().describe("Data pipeline display name or GUID"),
        job_instance_id: z.string().describe("The job instance ID to cancel"),
      },
    },
    safeTool(async ({ workspace, pipeline, job_instance_id }) => {
      const ws = await resolveWorkspace(workspace);
      const pl = await resolvePipeline(ws.id, pipeline);
      const data = await fabric(
        "POST",
        `/workspaces/${ws.id}/items/${pl.id}/jobs/instances/${encodeURIComponent(job_instance_id)}/cancel`,
      );
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} cancel_pipeline_run ws=${ws.id} item=${pl.id} job=${job_instance_id}`,
      );
      return ok({ cancelRequested: true, operationLocation: data._location ?? null });
    }),
  );

  server.registerTool(
    "refresh_dataset",
    {
      description:
        "Trigger an on-demand refresh of a semantic model (dataset). Returns the accepted request; use get_refresh_history to track completion. Accepts workspace + dataset by display name or GUID. Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        dataset: z.string().describe("Semantic model (dataset) display name or GUID"),
      },
    },
    safeTool(async ({ workspace, dataset }) => {
      const ws = await resolveWorkspace(workspace);
      const ds = await resolveDataset(ws.id, dataset);
      const data = await powerbi(
        "POST",
        `/groups/${ws.id}/datasets/${ds.id}/refreshes`,
        { notifyOption: "NoNotification" },
      );
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} refresh_dataset ws=${ws.id} dataset=${ds.id}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        dataset: { id: ds.id, displayName: ds.displayName ?? dataset },
        accepted: true,
        operationLocation: data._location ?? null,
      });
    }),
  );

  server.registerTool(
    "update_from_git",
    {
      description:
        "Update a Fabric workspace from its connected Git branch (pull repo -> workspace). Reads the current Git status to resolve the target commit, then updates, preferring the remote branch on conflicts. Long-running: poll get_git_status for completion. Requires the workspace to be connected to Git and FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
      },
    },
    safeTool(async ({ workspace }) => {
      const ws = await resolveWorkspace(workspace);
      const status = await fabric("GET", `/workspaces/${ws.id}/git/status`);
      const remoteCommitHash = status?.remoteCommitHash;
      if (!remoteCommitHash) {
        return {
          content: [
            {
              type: "text",
              text: `Workspace "${ws.displayName ?? ws.id}" has no remote commit to update from — is it connected to Git? Status: ${JSON.stringify(status)}`,
            },
          ],
          isError: true,
        };
      }
      const body = {
        remoteCommitHash,
        workspaceHead: status?.workspaceHead,
        conflictResolution: {
          conflictResolutionType: "Workspace",
          conflictResolutionPolicy: "PreferRemote",
        },
        options: { allowOverrideItems: true },
      };
      const data = await fabric("POST", `/workspaces/${ws.id}/git/updateFromGit`, body);
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} update_from_git ws=${ws.id} remoteCommitHash=${remoteCommitHash}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        requested: true,
        remoteCommitHash,
        operationLocation: data._location ?? null,
        note: "Update accepted (long-running). Poll get_git_status for completion.",
      });
    }),
  );

  server.registerTool(
    "update_item_definition",
    {
      description:
        "Deploy an item definition (semantic model, notebook, report, ...) to a live Fabric workspace from a local definition folder, OVERWRITING the item's current definition. Safety: snapshots the current live definition to a local JSON first (returned as snapshotPath) so you can roll back via restore_snapshot. Overwrites wholesale — definition_path must hold the COMPLETE definition (a .platform file is required). Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        item: z.string().describe("Target item display name or GUID"),
        type: z
          .string()
          .optional()
          .describe("Item type to disambiguate the name, e.g. SemanticModel, Notebook, Report"),
        definition_path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the local item definition folder (contains .platform and definition/). Provide this OR restore_snapshot.",
          ),
        restore_snapshot: z
          .string()
          .optional()
          .describe(
            "Absolute path to a snapshot JSON previously written by this tool, to roll back. Provide this OR definition_path.",
          ),
        update_metadata: z
          .boolean()
          .optional()
          .describe("Also update display name/description from the .platform file. Default false."),
      },
    },
    safeTool(async ({ workspace, item, type, definition_path, restore_snapshot, update_metadata }) => {
      if (!definition_path && !restore_snapshot)
        throw new Error("Provide either definition_path (folder to deploy) or restore_snapshot (JSON to roll back).");
      if (definition_path && restore_snapshot)
        throw new Error("Provide only one of definition_path or restore_snapshot.");
      const ws = await resolveWorkspace(workspace);
      const it = await resolveItem(ws.id, item, type);
      const definition = restore_snapshot
        ? readSnapshot(restore_snapshot)
        : readDefinitionFromDir(definition_path);
      if (!definition.parts?.length) throw new Error("No parts to deploy.");

      let snapshotPath = null;
      try {
        const current = await fabricLro("POST", `/workspaces/${ws.id}/items/${it.id}/getDefinition`);
        if (current?.definition?.parts?.length) snapshotPath = writeSnapshot(it.id, current.definition);
      } catch (e) {
        console.error(`[fabric-mcp] snapshot skipped for ${it.id}: ${e.message}`);
      }

      const q = update_metadata ? "?updateMetadata=true" : "";
      await fabricLro("POST", `/workspaces/${ws.id}/items/${it.id}/updateDefinition${q}`, { definition });
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} update_item_definition ws=${ws.id} item=${it.id} parts=${definition.parts.length} source=${restore_snapshot ? "snapshot" : definition_path} snapshot=${snapshotPath ?? "none"}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
        updated: true,
        partsDeployed: definition.parts.length,
        snapshotPath,
        rollback: snapshotPath
          ? `Roll back with update_item_definition restore_snapshot="${snapshotPath}"`
          : "No prior definition captured (item may have been empty); no automatic rollback available.",
      });
    }),
  );

  server.registerTool(
    "create_schedule",
    {
      description:
        "Create a job schedule on a Fabric item (data pipeline, notebook, ...). The schedule is owned by the identity that creates it. Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        item: z.string().describe("Item display name or GUID"),
        type: z.string().optional().describe("Item type to disambiguate the name, e.g. DataPipeline, Notebook"),
        job_type: z.string().optional().describe("Schedule job type (default 'Pipeline'; 'RunNotebook' for notebooks)"),
        enabled: z.boolean().optional().describe("Whether the schedule is enabled (default true)"),
        configuration: z
          .record(z.any())
          .describe(
            "Schedule configuration, e.g. { type: 'Daily', times: ['08:00','10:00'], localTimeZoneId: 'Eastern Standard Time', startDateTime: '2024-01-01T00:00:00' }. type is Cron | Daily | Weekly.",
          ),
      },
    },
    safeTool(async ({ workspace, item, type, job_type, enabled, configuration }) => {
      const ws = await resolveWorkspace(workspace);
      const it = await resolveItem(ws.id, item, type);
      const jt = job_type ?? "Pipeline";
      const body = { enabled: enabled ?? true, configuration };
      const data = await fabric(
        "POST",
        `/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jt)}/schedules`,
        body,
      );
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} create_schedule ws=${ws.id} item=${it.id} jobType=${jt}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
        jobType: jt,
        created: true,
        schedule: data,
      });
    }),
  );

  server.registerTool(
    "update_schedule",
    {
      description:
        "Update a job schedule on a Fabric item — enable/disable (pause/resume) or change its configuration. NOTE: a PATCH re-stamps the schedule's owner to the calling identity, so pausing/resuming a service-principal-owned schedule as a user flips its owner; recreate as the SPN afterward if ownership matters (see list_schedules). If you pass only 'enabled' or only 'configuration', the other is carried over from the current schedule. Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        item: z.string().describe("Item display name or GUID"),
        type: z.string().optional().describe("Item type to disambiguate the name"),
        job_type: z.string().optional().describe("Schedule job type (default 'Pipeline'; 'RunNotebook' for notebooks)"),
        schedule_id: z.string().describe("The schedule ID from list_schedules"),
        enabled: z.boolean().optional().describe("Enable/disable the schedule"),
        configuration: z.record(z.any()).optional().describe("Replacement schedule configuration object"),
      },
    },
    safeTool(async ({ workspace, item, type, job_type, schedule_id, enabled, configuration }) => {
      const ws = await resolveWorkspace(workspace);
      const it = await resolveItem(ws.id, item, type);
      const jt = job_type ?? "Pipeline";
      const base = `/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jt)}/schedules/${encodeURIComponent(schedule_id)}`;
      const current = await fabric("GET", base);
      const body = {
        enabled: enabled ?? current.enabled,
        configuration: configuration ?? current.configuration,
      };
      const data = await fabric("PATCH", base, body);
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} update_schedule ws=${ws.id} item=${it.id} schedule=${schedule_id} enabled=${body.enabled}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
        jobType: jt,
        updated: true,
        schedule: data,
      });
    }),
  );

  server.registerTool(
    "delete_schedule",
    {
      description:
        "Delete a job schedule from a Fabric item. Snapshots the schedule object to a local JSON first (returned as snapshotPath) for reference. Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        item: z.string().describe("Item display name or GUID"),
        type: z.string().optional().describe("Item type to disambiguate the name"),
        job_type: z.string().optional().describe("Schedule job type (default 'Pipeline'; 'RunNotebook' for notebooks)"),
        schedule_id: z.string().describe("The schedule ID from list_schedules"),
      },
    },
    safeTool(async ({ workspace, item, type, job_type, schedule_id }) => {
      const ws = await resolveWorkspace(workspace);
      const it = await resolveItem(ws.id, item, type);
      const jt = job_type ?? "Pipeline";
      const base = `/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jt)}/schedules/${encodeURIComponent(schedule_id)}`;
      let snapshotPath = null;
      try {
        const current = await fabric("GET", base);
        snapshotPath = writeSnapshot(`schedule-${schedule_id}`, current);
      } catch (e) {
        console.error(`[fabric-mcp] schedule snapshot skipped for ${schedule_id}: ${e.message}`);
      }
      await fabric("DELETE", base);
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} delete_schedule ws=${ws.id} item=${it.id} schedule=${schedule_id} snapshot=${snapshotPath ?? "none"}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
        jobType: jt,
        deleted: true,
        snapshotPath,
      });
    }),
  );

  server.registerTool(
    "deploy_stage",
    {
      description:
        "Selectively deploy items from one deployment-pipeline stage to the next (e.g. Dev -> Test). You MUST pass an explicit item list — this tool refuses an empty list so a blanket 'deploy everything' can't happen by accident. Long-running: polls to completion. NOTE: a deploy carries each item's schedule definition and recreates schedules under the CALLER's identity, and it repoints item references to the target stage but does NOT rebind data-source/gateway connections — re-check both after deploying (see list_schedules). Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        deployment_pipeline: z.string().describe("Deployment pipeline display name or GUID"),
        source_stage: z.string().describe("Source stage display name or GUID"),
        target_stage: z.string().describe("Target stage display name or GUID"),
        items: z
          .array(z.object({ sourceItemId: z.string(), itemType: z.string() }))
          .min(1)
          .describe("Items to deploy: [{ sourceItemId, itemType }], from list_deployment_stages stage items"),
        note: z.string().optional().describe("Optional deployment note"),
      },
    },
    safeTool(async ({ deployment_pipeline, source_stage, target_stage, items, note }) => {
      const dp = await resolveDeploymentPipeline(deployment_pipeline);
      const stages = await fabricListAll(`/deploymentPipelines/${dp.id}/stages`);
      const findStage = (s) =>
        stages.find((x) =>
          GUID_RE.test(s) ? x.id === s : (x.displayName ?? "").toLowerCase() === s.toLowerCase(),
        );
      const src = findStage(source_stage);
      const tgt = findStage(target_stage);
      if (!src)
        throw new Error(
          `Source stage "${source_stage}" not found. Stages: ${stages.map((s) => s.displayName).join(", ")}`,
        );
      if (!tgt)
        throw new Error(
          `Target stage "${target_stage}" not found. Stages: ${stages.map((s) => s.displayName).join(", ")}`,
        );
      const body = { sourceStageId: src.id, targetStageId: tgt.id, items, ...(note ? { note } : {}) };
      const data = await fabricLro("POST", `/deploymentPipelines/${dp.id}/deploy`, body);
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} deploy_stage dp=${dp.id} src=${src.id} tgt=${tgt.id} items=${items.length}`,
      );
      return ok({
        deploymentPipeline: { id: dp.id, displayName: dp.displayName ?? deployment_pipeline },
        source: { id: src.id, displayName: src.displayName },
        target: { id: tgt.id, displayName: tgt.displayName },
        itemsDeployed: items.length,
        result: data,
      });
    }),
  );

  server.registerTool(
    "run_notebook",
    {
      description:
        "Run a Fabric notebook on demand as a job. By default waits for a terminal status and returns a run summary; set wait=false to return immediately with the operation location. NOTE: executionData.parameters only inject when the notebook exposes a properly TAGGED parameters cell (ipynb format). A notebook that marks its parameters cell with a '# PARAMETERS_CELL' comment silently ignores injected values and runs with its in-source defaults while still reporting success. Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        notebook: z.string().describe("Notebook display name or GUID"),
        parameters: z
          .record(z.any())
          .optional()
          .describe("Typed parameters, e.g. { myParam: { value: '5', type: 'int' } }"),
        configuration: z
          .record(z.any())
          .optional()
          .describe("Optional executionData.configuration (Spark conf, environment, defaultLakehouse, ...)"),
        wait: z.boolean().optional().describe("Wait for terminal status (default true)"),
      },
    },
    safeTool(async ({ workspace, notebook, parameters, configuration, wait }) => {
      const ws = await resolveWorkspace(workspace);
      const nb = await resolveItem(ws.id, notebook, "Notebook");
      const executionData = {};
      if (parameters) executionData.parameters = parameters;
      if (configuration) executionData.configuration = configuration;
      const body = Object.keys(executionData).length ? { executionData } : undefined;
      const data = await fabric(
        "POST",
        `/workspaces/${ws.id}/items/${nb.id}/jobs/instances`,
        body,
        { jobType: "RunNotebook" },
      );
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} run_notebook ws=${ws.id} item=${nb.id}`,
      );
      const opLocation = data._location ?? null;
      if ((wait ?? true) && opLocation) {
        const ra = data._retryAfter ? parseInt(data._retryAfter, 10) : undefined;
        const finalState = await pollJobInstance(opLocation, ra);
        return ok({
          workspace: { id: ws.id, displayName: ws.displayName },
          notebook: { id: nb.id, displayName: nb.displayName ?? notebook },
          run: summarizeRun(finalState),
        });
      }
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        notebook: { id: nb.id, displayName: nb.displayName ?? notebook },
        accepted: true,
        operationLocation: opLocation,
        note: "Run accepted. Call again with wait=true to poll to completion.",
      });
    }),
  );

  server.registerTool(
    "create_item",
    {
      description:
        "Create a new item in a Fabric workspace, optionally from a local definition folder (.platform + definition/). Useful for scaffolding or temporary items (e.g. a notebook). Long-running when a definition is supplied. Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        display_name: z.string().describe("Display name for the new item"),
        type: z.string().describe("Item type, e.g. Notebook, DataPipeline, SemanticModel, Lakehouse"),
        description: z.string().optional().describe("Optional description"),
        definition_path: z
          .string()
          .optional()
          .describe(
            "Absolute path to a local item definition folder (contains .platform and definition/). Omit to create an empty item.",
          ),
      },
    },
    safeTool(async ({ workspace, display_name, type, description, definition_path }) => {
      const ws = await resolveWorkspace(workspace);
      const body = { displayName: display_name, type };
      if (description) body.description = description;
      if (definition_path) body.definition = readDefinitionFromDir(definition_path);
      const data = await fabricLro("POST", `/workspaces/${ws.id}/items`, body);
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} create_item ws=${ws.id} type=${type} name=${display_name}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        created: true,
        item: { id: data.id, displayName: data.displayName ?? display_name, type: data.type ?? type },
      });
    }),
  );

  server.registerTool(
    "delete_item",
    {
      description:
        "Delete an item from a Fabric workspace. Best-effort snapshots the item's definition first (returned as snapshotPath) for item types that support getDefinition. NOTE: Gen2 dataflows must be deleted via the dataflows endpoint — the generic items delete returns UnknownError for them; this tool switches automatically when the resolved type is Dataflow. Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        item: z.string().describe("Item display name or GUID"),
        type: z.string().optional().describe("Item type to disambiguate the name, e.g. Notebook, Dataflow, DataPipeline"),
      },
    },
    safeTool(async ({ workspace, item, type }) => {
      const ws = await resolveWorkspace(workspace);
      const it = await resolveItem(ws.id, item, type);
      // resolveItem short-circuits on a GUID and returns no type; fetch it so the
      // Gen2-dataflow delete quirk still triggers when the caller passed a GUID.
      let itType = it.type;
      if (!itType) {
        try {
          const meta = await fabric("GET", `/workspaces/${ws.id}/items/${it.id}`);
          itType = meta.type;
        } catch (e) {
          console.error(`[fabric-mcp] type lookup skipped for ${it.id}: ${e.message}`);
        }
      }
      let snapshotPath = null;
      try {
        const current = await fabricLro("POST", `/workspaces/${ws.id}/items/${it.id}/getDefinition`);
        if (current?.definition?.parts?.length) snapshotPath = writeSnapshot(it.id, current.definition);
      } catch (e) {
        console.error(`[fabric-mcp] snapshot skipped for ${it.id}: ${e.message}`);
      }
      const isDataflow = (itType ?? "").toLowerCase() === "dataflow";
      const path = isDataflow
        ? `/workspaces/${ws.id}/dataflows/${it.id}`
        : `/workspaces/${ws.id}/items/${it.id}`;
      await fabric("DELETE", path);
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} delete_item ws=${ws.id} item=${it.id} type=${itType ?? "?"} snapshot=${snapshotPath ?? "none"}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: { id: it.id, displayName: it.displayName ?? item, type: itType },
        deleted: true,
        snapshotPath,
        rollback: snapshotPath
          ? `Recreate with create_item from the snapshot's parts (${snapshotPath})`
          : "No definition captured; no automatic restore available.",
      });
    }),
  );

  server.registerTool(
    "add_workspace_role",
    {
      description:
        "Grant a principal (user, group, or service principal) a role on a Fabric workspace. Roles: Admin, Member, Contributor, Viewer. Requires FABRIC_MCP_MODE=write.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
        principal_id: z.string().describe("Object ID of the principal to grant access to"),
        principal_type: z
          .string()
          .optional()
          .describe("Principal type: User, Group, ServicePrincipal, or ServicePrincipalProfile (default ServicePrincipal)"),
        role: z.string().describe("Role to grant: Admin, Member, Contributor, or Viewer"),
      },
    },
    safeTool(async ({ workspace, principal_id, principal_type, role }) => {
      const ws = await resolveWorkspace(workspace);
      const principal = { id: principal_id, type: principal_type ?? "ServicePrincipal" };
      const data = await fabric("POST", `/workspaces/${ws.id}/roleAssignments`, { principal, role });
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} add_workspace_role ws=${ws.id} principal=${principal_id} type=${principal.type} role=${role}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        granted: true,
        principal,
        role,
        result: data,
      });
    }),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[fabric-mcp] v${VERSION} ready (mode=${WRITE_ENABLED ? "write" : "read"})`);
