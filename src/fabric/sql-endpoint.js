import { fabric } from "../http/client.js";

const ENDPOINT_PARENTS = {
  lakehouse: "lakehouses",
  mirroddatabase: "mirroredDatabases",
  mirroreddatabase: "mirroredDatabases",
};

/**
 * Turn ["dbo.orders", "customers", "sales.daily"] into the TableDefinition[]
 * shape refreshMetadata expects, grouping by schema (default dbo).
 */
function groupTables(tables, defaultSchema = "dbo") {
  const bySchema = new Map();
  for (const raw of tables ?? []) {
    const name = String(raw).trim();
    if (!name) continue;
    const dot = name.indexOf(".");
    const schema = dot === -1 ? defaultSchema : name.slice(0, dot);
    const table = dot === -1 ? name : name.slice(dot + 1);
    if (!bySchema.has(schema)) bySchema.set(schema, []);
    bySchema.get(schema).push(table);
  }
  return [...bySchema.entries()].map(([schema, tableNames]) => ({ schema, tableNames }));
}

async function resolveSqlEndpointId(workspaceId, item) {
  const type = (item.type ?? "").toLowerCase();
  if (type === "sqlendpoint") return { sqlEndpointId: item.id, via: "SQLEndpoint" };
  const collection = ENDPOINT_PARENTS[type];
  if (!collection) {
    throw new Error(
      `Item type ${item.type ?? "unknown"} has no SQL analytics endpoint to refresh. Pass a Lakehouse, MirroredDatabase, or the SQLEndpoint item itself (set type to disambiguate).`,
    );
  }
  const detail = await fabric("GET", `/workspaces/${workspaceId}/${collection}/${item.id}`);
  const endpoint = detail?.properties?.sqlEndpointProperties;
  if (!endpoint?.id) {
    throw new Error(`No sqlEndpointProperties on ${item.type} ${item.id} (provisioningStatus=${endpoint?.provisioningStatus ?? "unknown"}).`);
  }
  return { sqlEndpointId: endpoint.id, via: item.type, provisioningStatus: endpoint.provisioningStatus, connectionString: endpoint.connectionString };
}

export { groupTables, resolveSqlEndpointId };
