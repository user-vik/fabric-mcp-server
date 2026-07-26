import { fabricListAll } from "../http/client.js";

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wsCache = new Map();
const pipeCache = new Map();
const smCache = new Map();
const itemCache = new Map();
const deployPipeCache = new Map();

async function resolveWorkspace(workspace) {
  if (!workspace) throw new Error("workspace is required (display name or GUID)");
  if (GUID_RE.test(workspace)) return { id: workspace, displayName: undefined };
  const key = workspace.toLowerCase();
  if (wsCache.has(key)) return wsCache.get(key);
  const all = await fabricListAll("/workspaces");
  for (const entry of all) {
    wsCache.set((entry.displayName ?? "").toLowerCase(), {
      id: entry.id,
      displayName: entry.displayName,
    });
  }
  const hit = wsCache.get(key);
  if (!hit) {
    const names = all.map((entry) => entry.displayName).filter(Boolean);
    throw new Error(`Workspace "${workspace}" not found. Available: ${names.join(", ") || "(none)"}`);
  }
  return hit;
}

async function resolvePipeline(workspaceId, pipeline) {
  if (!pipeline) throw new Error("pipeline is required (display name or GUID)");
  if (GUID_RE.test(pipeline)) return { id: pipeline, displayName: undefined };
  const key = `${workspaceId}/${pipeline.toLowerCase()}`;
  if (pipeCache.has(key)) return pipeCache.get(key);
  const items = await fabricListAll(`/workspaces/${workspaceId}/items?type=DataPipeline`);
  for (const item of items) {
    pipeCache.set(`${workspaceId}/${(item.displayName ?? "").toLowerCase()}`, {
      id: item.id,
      displayName: item.displayName,
    });
  }
  const hit = pipeCache.get(key);
  if (!hit) {
    const names = items.map((item) => item.displayName).filter(Boolean);
    throw new Error(
      `Data pipeline "${pipeline}" not found in workspace. Available: ${names.join(", ") || "(none)"}`,
    );
  }
  return hit;
}

async function resolveDataset(workspaceId, dataset) {
  if (!dataset) throw new Error("dataset is required (semantic model display name or GUID)");
  if (GUID_RE.test(dataset)) return { id: dataset, displayName: undefined };
  const key = `${workspaceId}/${dataset.toLowerCase()}`;
  if (smCache.has(key)) return smCache.get(key);
  const items = await fabricListAll(`/workspaces/${workspaceId}/items?type=SemanticModel`);
  for (const item of items) {
    smCache.set(`${workspaceId}/${(item.displayName ?? "").toLowerCase()}`, {
      id: item.id,
      displayName: item.displayName,
    });
  }
  const hit = smCache.get(key);
  if (!hit) {
    const names = items.map((item) => item.displayName).filter(Boolean);
    throw new Error(
      `Semantic model "${dataset}" not found in workspace. Available: ${names.join(", ") || "(none)"}`,
    );
  }
  return hit;
}

async function resolveItem(workspaceId, item, type) {
  if (!item) throw new Error("item is required (display name or GUID)");
  if (GUID_RE.test(item)) return { id: item, displayName: undefined, type };
  const key = `${workspaceId}/${(type ?? "*").toLowerCase()}/${item.toLowerCase()}`;
  if (itemCache.has(key)) return itemCache.get(key);
  const path = `/workspaces/${workspaceId}/items${type ? `?type=${encodeURIComponent(type)}` : ""}`;
  const items = await fabricListAll(path);
  const matches = items.filter((entry) => (entry.displayName ?? "").toLowerCase() === item.toLowerCase());
  if (matches.length === 0) {
    const names = items.map((entry) => entry.displayName).filter(Boolean);
    throw new Error(
      `Item "${item}"${type ? ` of type ${type}` : ""} not found in workspace. Available: ${names.slice(0, 50).join(", ") || "(none)"}`,
    );
  }
  if (matches.length > 1) {
    const types = [...new Set(matches.map((match) => match.type))];
    throw new Error(
      `Item "${item}" is ambiguous (${matches.length} matches, types: ${types.join(", ")}). Pass type to disambiguate or use the GUID.`,
    );
  }
  const hit = {
    id: matches[0].id,
    displayName: matches[0].displayName,
    type: matches[0].type,
  };
  itemCache.set(key, hit);
  return hit;
}

async function resolveDeploymentPipeline(pipeline) {
  if (!pipeline) throw new Error("deployment_pipeline is required (display name or GUID)");
  if (GUID_RE.test(pipeline)) return { id: pipeline, displayName: undefined };
  const key = pipeline.toLowerCase();
  if (deployPipeCache.has(key)) return deployPipeCache.get(key);
  const all = await fabricListAll("/deploymentPipelines");
  for (const entry of all) {
    deployPipeCache.set((entry.displayName ?? "").toLowerCase(), {
      id: entry.id,
      displayName: entry.displayName,
    });
  }
  const hit = deployPipeCache.get(key);
  if (!hit) {
    const names = all.map((entry) => entry.displayName).filter(Boolean);
    throw new Error(
      `Deployment pipeline "${pipeline}" not found. Available: ${names.join(", ") || "(none)"}`,
    );
  }
  return hit;
}

export {
  GUID_RE,
  resolveDataset,
  resolveDeploymentPipeline,
  resolveItem,
  resolvePipeline,
  resolveWorkspace,
};
