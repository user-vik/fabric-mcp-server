#!/usr/bin/env node
import { readFileSync } from "node:fs";
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
const MAX_RETRIES = 3;
const RETRY_MAX_DELAY_MS = 60_000;

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
    // 202 Accepted (long-running ops) carries useful headers but often no body.
    const result = text ? JSON.parse(text) : {};
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
  console.error("[fabric-mcp] write mode enabled — run_pipeline + cancel_pipeline_run exposed");
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
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[fabric-mcp] v${VERSION} ready (mode=${WRITE_ENABLED ? "write" : "read"})`);
