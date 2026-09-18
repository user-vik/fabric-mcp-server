import { z } from "zod";
import { connectionOut, matchConnections } from "../fabric/connections.js";
import { resolveDataset, resolveItem, resolveWorkspace } from "../fabric/resolvers.js";
import { fabric, fabricListAll, powerbi } from "../http/client.js";
import { audit, defineTool, itemOut, wsOut } from "./define.js";

const workspaceField = z.string().describe("Workspace display name or GUID");
const datasetField = z.string().describe("Semantic model (dataset) display name or GUID");

const dsOut = (ds, fallback) => ({ id: ds.id, displayName: ds.displayName ?? fallback });

const executeDax = defineTool({
  name: "execute_dax",
  description:
    "Run a read-only DAX query against a Fabric/Power BI semantic model and return the result rows. Accepts workspace + dataset (semantic model) by display name or GUID. Use to validate measures or run ad-hoc analytics against a live model, e.g. 'EVALUATE ROW(\"x\", [Some Measure])'. Read-only: the Power BI executeQueries API rejects data-modifying DAX. Requires the caller to have Build permission on the dataset and the tenant's \"Dataset Execute Queries REST API\" setting enabled.",
  schema: {
    workspace: workspaceField,
    dataset: datasetField,
    dax: z.string().describe("A DAX query, e.g. starting with EVALUATE or DEFINE ... EVALUATE"),
    impersonated_user: z.string().optional().describe("Optional UPN to evaluate under for row-level security (effectiveUserName)"),
  },
  handler: async ({ workspace, dataset, dax, impersonated_user }) => {
    const ws = await resolveWorkspace(workspace);
    const ds = await resolveDataset(ws.id, dataset);
    const body = { queries: [{ query: dax }], serializerSettings: { includeNulls: true } };
    if (impersonated_user) body.impersonatedUserName = impersonated_user;
    const data = await powerbi("POST", `/groups/${ws.id}/datasets/${ds.id}/executeQueries`, body);
    const tables = data?.results?.[0]?.tables ?? [];
    return {
      workspace: wsOut(ws),
      dataset: dsOut(ds, dataset),
      rowCount: tables[0]?.rows?.length ?? 0,
      rows: tables[0]?.rows ?? [],
      ...(tables.length > 1 ? { additionalTables: tables.slice(1) } : {}),
    };
  },
});

const getRefreshHistory = defineTool({
  name: "get_refresh_history",
  description:
    "Get recent refresh history for a semantic model (dataset), most-recent first — check whether a scheduled or on-demand refresh succeeded and why it failed. Accepts workspace + dataset by display name or GUID.",
  schema: {
    workspace: workspaceField,
    dataset: datasetField,
    top: z.number().int().positive().max(100).optional().describe("Max refresh entries to return (default 20)"),
  },
  handler: async ({ workspace, dataset, top }) => {
    const ws = await resolveWorkspace(workspace);
    const ds = await resolveDataset(ws.id, dataset);
    const data = await powerbi("GET", `/groups/${ws.id}/datasets/${ds.id}/refreshes`, null, { $top: top ?? 20 });
    return { workspace: wsOut(ws), dataset: dsOut(ds, dataset), refreshes: data.value ?? [] };
  },
});

const refreshDataset = defineTool({
  name: "refresh_dataset",
  mode: "write",
  description:
    "Trigger an on-demand refresh of a semantic model (dataset). Returns the accepted request; use get_refresh_history to track completion. Accepts workspace + dataset by display name or GUID. Requires FABRIC_MCP_MODE=write.",
  schema: { workspace: workspaceField, dataset: datasetField },
  handler: async ({ workspace, dataset }) => {
    const ws = await resolveWorkspace(workspace);
    const ds = await resolveDataset(ws.id, dataset);
    const data = await powerbi("POST", `/groups/${ws.id}/datasets/${ds.id}/refreshes`, { notifyOption: "NoNotification" });
    audit("refresh_dataset", { ws: ws.id, dataset: ds.id });
    return { workspace: wsOut(ws), dataset: dsOut(ds, dataset), accepted: true, operationLocation: data._location ?? null };
  },
});

function datasourceOut(source) {
  return {
    datasourceType: source.datasourceType,
    connectionDetails: source.connectionDetails,
    datasourceId: source.datasourceId ?? null,
    gatewayId: source.gatewayId ?? null,
    bound: Boolean(source.gatewayId),
  };
}

const getDatasetDatasources = defineTool({
  name: "get_dataset_datasources",
  description:
    "List the Power BI data sources of a semantic model with their gateway binding — datasourceType, connectionDetails, and gatewayId/datasourceId (empty when NOT bound). Use it to detect unbound sources after a git sync or deploy, or to read a working sibling model's binding IDs to reuse with bind_dataset_to_gateway. Requires write permission on the dataset (Power BI API rule).",
  schema: { workspace: workspaceField, dataset: datasetField },
  handler: async ({ workspace, dataset }) => {
    const ws = await resolveWorkspace(workspace);
    const ds = await resolveDataset(ws.id, dataset);
    const data = await powerbi("GET", `/groups/${ws.id}/datasets/${ds.id}/datasources`);
    const datasources = (data.value ?? []).map(datasourceOut);
    return {
      workspace: wsOut(ws),
      dataset: dsOut(ds, dataset),
      count: datasources.length,
      unboundCount: datasources.filter((source) => !source.bound).length,
      datasources,
    };
  },
});

const bindDatasetToGateway = defineTool({
  name: "bind_dataset_to_gateway",
  mode: "write",
  description:
    "Bind a semantic model's data sources to a gateway (Power BI BindToGateway). Fixes the 'default data connection without explicit credentials' refresh failure a git-synced or deployed model lands with. Pass the gateway ID and, ideally, the datasource IDs — read them from a working sibling model with get_dataset_datasources. Without datasource IDs the service binds to the first matching gateway data source. Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    dataset: datasetField,
    gateway_id: z.string().describe("Gateway object ID (gatewayId from get_dataset_datasources on a bound model)"),
    datasource_ids: z
      .array(z.string())
      .optional()
      .describe("Gateway datasource object IDs to bind (datasourceId values from a bound sibling model). Omit to let the service pick the first match."),
  },
  handler: async ({ workspace, dataset, gateway_id, datasource_ids }) => {
    const ws = await resolveWorkspace(workspace);
    const ds = await resolveDataset(ws.id, dataset);
    const body = { gatewayObjectId: gateway_id, ...(datasource_ids?.length ? { datasourceObjectIds: datasource_ids } : {}) };
    await powerbi("POST", `/groups/${ws.id}/datasets/${ds.id}/Default.BindToGateway`, body);
    audit("bind_dataset_to_gateway", { ws: ws.id, dataset: ds.id, gateway: gateway_id, datasources: datasource_ids?.length ?? "auto" });
    const after = await powerbi("GET", `/groups/${ws.id}/datasets/${ds.id}/datasources`);
    return {
      workspace: wsOut(ws),
      dataset: dsOut(ds, dataset),
      bound: true,
      gatewayId: gateway_id,
      datasources: (after.value ?? []).map(datasourceOut),
    };
  },
});

const TAKEOVER_PATHS = {
  semanticmodel: (ws, id) => `/groups/${ws}/datasets/${id}/Default.TakeOver`,
  paginatedreport: (ws, id) => `/groups/${ws}/reports/${id}/Default.TakeOver`,
};

const takeoverItem = defineTool({
  name: "takeover_item",
  mode: "write",
  description:
    "Take over ownership of a semantic model, or of a paginated report's data sources, as the calling identity (Power BI TakeOver). Unblocks deployment-pipeline errors like Alm_InvalidRequest_NotPaginatedReportOwner and refreshes that fail because the previous owner left. Supports SemanticModel and PaginatedReport only. Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Semantic model or paginated report display name or GUID"),
    type: z.string().optional().describe("SemanticModel or PaginatedReport (required when the name is ambiguous or a GUID is passed)"),
  },
  handler: async ({ workspace, item, type }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    let itemType = it.type ?? type;
    if (!itemType) {
      const meta = await fabric("GET", `/workspaces/${ws.id}/items/${it.id}`);
      itemType = meta.type;
    }
    const pathFor = TAKEOVER_PATHS[(itemType ?? "").toLowerCase()];
    if (!pathFor) {
      throw new Error(`takeover_item supports SemanticModel and PaginatedReport; got ${itemType ?? "unknown"}. Pass type to disambiguate.`);
    }
    await powerbi("POST", pathFor(ws.id, it.id));
    audit("takeover_item", { ws: ws.id, item: it.id, type: itemType });
    return { workspace: wsOut(ws), item: { ...itemOut(it, item), type: itemType }, takenOver: true };
  },
});

const getItemConnections = defineTool({
  name: "get_item_connections",
  description:
    "List the data connections a Fabric item is bound to (Fabric item connections API): connection id, connectivityType, gateway, and connectionDetails type + path. A semantic model showing connectivityType 'Automatic' or 'None' is UNBOUND and its refresh will fail with 'default data connection without explicit connection credentials' — every deployment-pipeline leg resets bindings this way. Check this BEFORE bind_semantic_model_connection so the path already points at the target stage. Accepts workspace + item by display name or GUID.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Item display name or GUID (typically a semantic model)"),
    type: z.string().optional().describe("Item type to disambiguate the name, e.g. SemanticModel"),
  },
  handler: async ({ workspace, item, type }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const connections = await fabricListAll(`/workspaces/${ws.id}/items/${it.id}/connections`);
    const mapped = connections.map(connectionOut);
    return {
      workspace: wsOut(ws),
      item: itemOut(it, item),
      count: mapped.length,
      unboundCount: mapped.filter((connection) => !connection.bound).length,
      connections: mapped,
    };
  },
});

const bindSemanticModelConnection = defineTool({
  name: "bind_semantic_model_connection",
  mode: "write",
  description:
    "Bind a semantic model's data source reference to a Fabric data connection (semanticModels/{id}/bindConnection). Two ways to call it: (a) explicit — connection_id + connection_type + connection_path (copy type/path EXACTLY from get_item_connections; a OneLake/ADLS path keeps its trailing slash or the API returns BindConnectionDetailNotFound); or (b) copy_from — name a sibling semantic model in the SAME workspace that is already bound, and every unbound source on the target is matched by connection type + path and bound with the sibling's connection. One API call per data source. Caller must own the model (see takeover_item). Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    dataset: datasetField,
    copy_from: z
      .string()
      .optional()
      .describe("A bound semantic model in the same workspace to copy connection bindings from (display name or GUID)"),
    connection_id: z.string().optional().describe("Explicit mode: the Fabric connection object ID to bind"),
    connectivity_type: z
      .string()
      .optional()
      .describe("Explicit mode: ShareableCloud (default), OnPremisesGateway, VirtualNetworkGateway, PersonalCloud, ... Use 'None' to UNBIND."),
    connection_type: z.string().optional().describe("Explicit mode: connectionDetails.type, e.g. SQL, AzureDataLakeStorage"),
    connection_path: z.string().optional().describe("Explicit mode: connectionDetails.path exactly as get_item_connections shows it"),
  },
  handler: async ({ workspace, dataset, copy_from, connection_id, connectivity_type, connection_type, connection_path }) => {
    const ws = await resolveWorkspace(workspace);
    const ds = await resolveDataset(ws.id, dataset);
    const endpoint = `/workspaces/${ws.id}/semanticModels/${ds.id}/bindConnection`;
    const listTarget = async () => (await fabricListAll(`/workspaces/${ws.id}/items/${ds.id}/connections`)).map(connectionOut);
    const bind = async (binding) => {
      await fabric("POST", endpoint, { connectionBinding: binding });
      audit("bind_semantic_model_connection", {
        ws: ws.id,
        dataset: ds.id,
        connection: binding.id ?? "none",
        type: binding.connectionDetails?.type,
      });
    };

    if (copy_from) {
      if (connection_id || connection_type || connection_path) {
        throw new Error("Pass either copy_from or the explicit connection_* fields, not both.");
      }
      const source = await resolveDataset(ws.id, copy_from);
      const [targetConnections, sourceConnections] = await Promise.all([
        fabricListAll(`/workspaces/${ws.id}/items/${ds.id}/connections`),
        fabricListAll(`/workspaces/${ws.id}/items/${source.id}/connections`),
      ]);
      const { plan, unmatched, alreadyBound } = matchConnections(targetConnections, sourceConnections);
      if (!plan.length && !unmatched.length) {
        return { workspace: wsOut(ws), dataset: dsOut(ds, dataset), bound: [], alreadyBound, note: "Every data source is already bound." };
      }
      const bound = [];
      for (const step of plan) {
        await bind({
          id: step.source.id,
          connectivityType: step.source.connectivityType,
          connectionDetails: { type: step.target.connectionDetails.type, path: step.target.connectionDetails.path },
        });
        bound.push({ connectionId: step.source.id, connectionDetails: step.target.connectionDetails, matchedBy: step.matchedBy });
      }
      return {
        workspace: wsOut(ws),
        dataset: dsOut(ds, dataset),
        copiedFrom: dsOut(source, copy_from),
        bound,
        alreadyBound,
        unmatched,
        connectionsAfter: await listTarget(),
      };
    }

    if (!connection_type || !connection_path) {
      throw new Error(
        "Explicit mode needs connection_type and connection_path (copy them from get_item_connections), plus connection_id unless connectivity_type is 'None'.",
      );
    }
    const connectivityType = connectivity_type ?? "ShareableCloud";
    if (connectivityType.toLowerCase() !== "none" && !connection_id) {
      throw new Error("connection_id is required unless connectivity_type is 'None' (unbind).");
    }
    const binding = {
      ...(connection_id ? { id: connection_id } : {}),
      connectivityType,
      connectionDetails: { type: connection_type, path: connection_path },
    };
    await bind(binding);
    return { workspace: wsOut(ws), dataset: dsOut(ds, dataset), bound: [binding], connectionsAfter: await listTarget() };
  },
});

export default [
  executeDax,
  getRefreshHistory,
  refreshDataset,
  getDatasetDatasources,
  bindDatasetToGateway,
  takeoverItem,
  getItemConnections,
  bindSemanticModelConnection,
];
