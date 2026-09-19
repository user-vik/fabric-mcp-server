import { z } from "zod";
import { readDefinitionFromDir, readSnapshot, writeSnapshot } from "../fabric/files.js";
import { resolveItem, resolveWorkspace } from "../fabric/resolvers.js";
import { groupTables, resolveSqlEndpointId } from "../fabric/sql-endpoint.js";
import { fabric } from "../http/client.js";
import { fabricLro } from "../http/polling.js";
import { audit, defineTool, itemOut, wsOut } from "./define.js";

const workspaceField = z.string().describe("Workspace display name or GUID");

const getItemDefinition = defineTool({
  name: "get_item_definition",
  description:
    "Get the definition (source parts) of a Fabric item — semantic model TMDL, notebook content, report, etc. By default returns a manifest of part paths (no payloads, to stay small); pass 'part' with a path to get that file's decoded contents. Useful for inspecting or backing up a live item before deploying. Accepts workspace + item by display name or GUID.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Item display name or GUID"),
    type: z.string().optional().describe("Item type to disambiguate the name, e.g. SemanticModel, Notebook, Report"),
    format: z.string().optional().describe("Optional definition format, e.g. 'ipynb' for notebooks"),
    part: z.string().optional().describe("A part path (from the manifest) to return decoded to text"),
  },
  handler: async ({ workspace, item, type, format, part }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const query = format ? `?format=${encodeURIComponent(format)}` : "";
    const data = await fabricLro("POST", `/workspaces/${ws.id}/items/${it.id}/getDefinition${query}`);
    const parts = data?.definition?.parts ?? [];
    if (part) {
      const selected = parts.find((entry) => entry.path === part);
      if (!selected) throw new Error(`Part "${part}" not found. Parts: ${parts.map((entry) => entry.path).join(", ")}`);
      const content =
        selected.payloadType === "InlineBase64"
          ? Buffer.from(selected.payload ?? "", "base64").toString("utf8")
          : `(non-base64 payloadType: ${selected.payloadType})`;
      return { workspace: wsOut(ws), item: itemOut(it, item), part: { path: selected.path, payloadType: selected.payloadType, content } };
    }
    return {
      workspace: wsOut(ws),
      item: itemOut(it, item),
      partCount: parts.length,
      parts: parts.map((entry) => ({ path: entry.path, payloadType: entry.payloadType, base64Length: (entry.payload ?? "").length })),
      note: "Call again with 'part' set to a path to get that file's decoded contents.",
    };
  },
});

const updateItemDefinition = defineTool({
  name: "update_item_definition",
  mode: "write",
  description:
    "Deploy an item definition (semantic model, notebook, report, ...) to a live Fabric workspace from a local definition folder, OVERWRITING the item's current definition. Safety: snapshots the current live definition to a local JSON first (returned as snapshotPath) so you can roll back via restore_snapshot. Overwrites wholesale — definition_path must hold the COMPLETE definition (a .platform file is required). Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Target item display name or GUID"),
    type: z.string().optional().describe("Item type to disambiguate the name, e.g. SemanticModel, Notebook, Report"),
    definition_path: z
      .string()
      .optional()
      .describe("Absolute path to the local item definition folder (contains .platform and definition/). Provide this OR restore_snapshot."),
    restore_snapshot: z
      .string()
      .optional()
      .describe("Absolute path to a snapshot JSON previously written by this tool, to roll back. Provide this OR definition_path."),
    update_metadata: z.boolean().optional().describe("Also update display name/description from the .platform file. Default false."),
  },
  handler: async ({ workspace, item, type, definition_path, restore_snapshot, update_metadata }) => {
    if (!definition_path && !restore_snapshot) {
      throw new Error("Provide either definition_path (folder to deploy) or restore_snapshot (JSON to roll back).");
    }
    if (definition_path && restore_snapshot) throw new Error("Provide only one of definition_path or restore_snapshot.");
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const definition = restore_snapshot ? readSnapshot(restore_snapshot) : readDefinitionFromDir(definition_path);
    if (!definition.parts?.length) throw new Error("No parts to deploy.");

    let snapshotPath = null;
    try {
      const current = await fabricLro("POST", `/workspaces/${ws.id}/items/${it.id}/getDefinition`);
      if (current?.definition?.parts?.length) snapshotPath = writeSnapshot(it.id, current.definition);
    } catch (error) {
      console.error(`[fabric-mcp] snapshot skipped for ${it.id}: ${error.message}`);
    }

    const query = update_metadata ? "?updateMetadata=true" : "";
    await fabricLro("POST", `/workspaces/${ws.id}/items/${it.id}/updateDefinition${query}`, { definition });
    audit("update_item_definition", {
      ws: ws.id,
      item: it.id,
      parts: definition.parts.length,
      source: restore_snapshot ? "snapshot" : definition_path,
      snapshot: snapshotPath ?? "none",
    });
    return {
      workspace: wsOut(ws),
      item: itemOut(it, item),
      updated: true,
      partsDeployed: definition.parts.length,
      snapshotPath,
      rollback: snapshotPath
        ? `Roll back with update_item_definition restore_snapshot="${snapshotPath}"`
        : "No prior definition captured (item may have been empty); no automatic rollback available.",
    };
  },
});

const createItem = defineTool({
  name: "create_item",
  mode: "write",
  description:
    "Create a new item in a Fabric workspace, optionally from a local definition folder (.platform + definition/). Useful for scaffolding or temporary items (e.g. a notebook). Long-running when a definition is supplied. Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    display_name: z.string().describe("Display name for the new item"),
    type: z.string().describe("Item type, e.g. Notebook, DataPipeline, SemanticModel, Lakehouse"),
    description: z.string().optional().describe("Optional description"),
    definition_path: z
      .string()
      .optional()
      .describe("Absolute path to a local item definition folder (contains .platform and definition/). Omit to create an empty item."),
  },
  handler: async ({ workspace, display_name, type, description, definition_path }) => {
    const ws = await resolveWorkspace(workspace);
    const body = { displayName: display_name, type };
    if (description) body.description = description;
    if (definition_path) body.definition = readDefinitionFromDir(definition_path);
    const data = await fabricLro("POST", `/workspaces/${ws.id}/items`, body);
    audit("create_item", { ws: ws.id, type, name: display_name });
    return { workspace: wsOut(ws), created: true, item: { id: data.id, displayName: data.displayName ?? display_name, type: data.type ?? type } };
  },
});

const deleteItem = defineTool({
  name: "delete_item",
  mode: "write",
  description:
    "Delete an item from a Fabric workspace. Best-effort snapshots the item's definition first (returned as snapshotPath) for item types that support getDefinition. NOTE: Gen2 dataflows must be deleted via the dataflows endpoint — the generic items delete returns UnknownError for them; this tool switches automatically when the resolved type is Dataflow. Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Item display name or GUID"),
    type: z.string().optional().describe("Item type to disambiguate the name, e.g. Notebook, Dataflow, DataPipeline"),
  },
  handler: async ({ workspace, item, type }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    let itemType = it.type;
    if (!itemType) {
      try {
        const meta = await fabric("GET", `/workspaces/${ws.id}/items/${it.id}`);
        itemType = meta.type;
      } catch (error) {
        console.error(`[fabric-mcp] type lookup skipped for ${it.id}: ${error.message}`);
      }
    }
    let snapshotPath = null;
    try {
      const current = await fabricLro("POST", `/workspaces/${ws.id}/items/${it.id}/getDefinition`);
      if (current?.definition?.parts?.length) snapshotPath = writeSnapshot(it.id, current.definition);
    } catch (error) {
      console.error(`[fabric-mcp] snapshot skipped for ${it.id}: ${error.message}`);
    }
    const isDataflow = (itemType ?? "").toLowerCase() === "dataflow";
    await fabric("DELETE", isDataflow ? `/workspaces/${ws.id}/dataflows/${it.id}` : `/workspaces/${ws.id}/items/${it.id}`);
    audit("delete_item", { ws: ws.id, item: it.id, type: itemType ?? "?", snapshot: snapshotPath ?? "none" });
    return {
      workspace: wsOut(ws),
      item: { id: it.id, displayName: it.displayName ?? item, type: itemType },
      deleted: true,
      snapshotPath,
      rollback: snapshotPath
        ? `Recreate with create_item from the snapshot's parts (${snapshotPath})`
        : "No definition captured; no automatic restore available.",
    };
  },
});

const refreshSqlEndpointMetadata = defineTool({
  name: "refresh_sql_endpoint_metadata",
  mode: "write",
  description:
    "Force the SQL analytics endpoint of a lakehouse (or mirrored database) to re-sync its table metadata NOW. The endpoint normally lags minutes behind Spark/Delta writes, so right after a notebook run it can still show the old schema and rows and look like a failed load. Resolves the endpoint ID from the lakehouse; optionally scope to specific tables ('schema.table' or 'table', max 25) and/or recreate_tables to drop-and-rebuild. Returns per-table sync status. Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Lakehouse, MirroredDatabase, or SQLEndpoint display name or GUID"),
    type: z.string().optional().describe("Item type to disambiguate the name (Lakehouse, MirroredDatabase, SQLEndpoint)"),
    tables: z
      .array(z.string().min(1))
      .max(25)
      .optional()
      .describe("Only refresh these tables, as 'schema.table' or 'table' (default schema dbo); the API accepts at most 25 per request. Omit for all tables."),
    recreate_tables: z.boolean().optional().describe("Drop and recreate the (scoped) tables on the endpoint (default false)"),
  },
  handler: async ({ workspace, item, type, tables, recreate_tables }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    let resolvedType = it.type;
    if (!resolvedType) {
      const meta = await fabric("GET", `/workspaces/${ws.id}/items/${it.id}`);
      resolvedType = meta.type;
    }
    const endpoint = await resolveSqlEndpointId(ws.id, { ...it, type: resolvedType });
    const body = {};
    if (tables?.length) body.tables = groupTables(tables);
    if (recreate_tables) body.recreateTables = true;
    const result = await fabricLro(
      "POST",
      `/workspaces/${ws.id}/sqlEndpoints/${endpoint.sqlEndpointId}/refreshMetadata`,
      Object.keys(body).length ? body : undefined,
    );
    audit("refresh_sql_endpoint_metadata", {
      ws: ws.id,
      item: it.id,
      endpoint: endpoint.sqlEndpointId,
      tables: tables?.length ?? "all",
      recreate: Boolean(recreate_tables),
    });
    const statuses = result?.value ?? [];
    return {
      workspace: wsOut(ws),
      item: { ...itemOut(it, item), type: resolvedType },
      sqlEndpoint: endpoint,
      scoped: body.tables ?? null,
      recreateTables: Boolean(recreate_tables),
      summary: {
        total: statuses.length,
        success: statuses.filter((entry) => entry.status === "Success").length,
        failure: statuses.filter((entry) => entry.status === "Failure").length,
        notRun: statuses.filter((entry) => entry.status === "NotRun").length,
      },
      tables: statuses,
    };
  },
});

export default [getItemDefinition, updateItemDefinition, createItem, deleteItem, refreshSqlEndpointMetadata];
