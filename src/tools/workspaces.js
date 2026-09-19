import { z } from "zod";
import { listFolders, resolveFolder } from "../fabric/folders.js";
import { resolveItem, resolveWorkspace } from "../fabric/resolvers.js";
import { fabric, fabricListAll } from "../http/client.js";
import { audit, defineTool, itemOut, wsOut } from "./define.js";

const workspaceField = z.string().describe("Workspace display name or GUID");

const listWorkspaces = defineTool({
  name: "list_workspaces",
  description: "List all Microsoft Fabric workspaces the signed-in identity can see.",
  handler: async () => {
    const all = await fabricListAll("/workspaces");
    return all.map((workspace) => ({ id: workspace.id, displayName: workspace.displayName, capacityId: workspace.capacityId }));
  },
});

const listItems = defineTool({
  name: "list_items",
  description:
    "List items in a Fabric workspace — notebooks, lakehouses, warehouses, semantic models, reports, data pipelines, etc. Optional type filter. Accepts workspace by display name or GUID.",
  schema: {
    workspace: workspaceField,
    type: z
      .string()
      .optional()
      .describe("Optional item type filter, e.g. Notebook, Lakehouse, Warehouse, SemanticModel, Report, DataPipeline"),
  },
  handler: async ({ workspace, type }) => {
    const ws = await resolveWorkspace(workspace);
    const path = `/workspaces/${ws.id}/items${type ? `?type=${encodeURIComponent(type)}` : ""}`;
    const items = await fabricListAll(path);
    return {
      workspace: wsOut(ws),
      ...(type ? { type } : {}),
      count: items.length,
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        displayName: item.displayName,
        description: item.description,
        ...(item.folderId ? { folderId: item.folderId } : {}),
      })),
    };
  },
});

const listFoldersTool = defineTool({
  name: "list_folders",
  description:
    "List the folders in a Fabric workspace as a flat list with full paths (e.g. 'Reports/Sales'). Use to inspect or verify workspace folder structure — items reference their folder via folderId (see list_items). Accepts workspace by display name or GUID.",
  schema: { workspace: workspaceField },
  handler: async ({ workspace }) => {
    const ws = await resolveWorkspace(workspace);
    const folders = await listFolders(ws.id);
    return { workspace: wsOut(ws), count: folders.length, folders };
  },
});

const listWorkspaceRoles = defineTool({
  name: "list_workspace_roles",
  description:
    "List the role assignments on a Fabric workspace — which principals (users, groups, service principals) hold Admin/Member/Contributor/Viewer. Accepts workspace by display name or GUID.",
  schema: { workspace: workspaceField },
  handler: async ({ workspace }) => {
    const ws = await resolveWorkspace(workspace);
    const roles = await fabricListAll(`/workspaces/${ws.id}/roleAssignments`);
    return {
      workspace: wsOut(ws),
      roleAssignments: roles.map((role) => ({
        id: role.id,
        role: role.role,
        principal: role.principal
          ? { id: role.principal.id, displayName: role.principal.displayName, type: role.principal.type }
          : null,
      })),
    };
  },
});

const listSqlDatabases = defineTool({
  name: "list_sql_databases",
  description:
    "List the SQL databases in a Fabric workspace and their connection properties (server FQDN, database name, connection string) — resolve a database's endpoint without hunting through the portal. Accepts workspace by display name or GUID; optional name filter.",
  schema: {
    workspace: workspaceField,
    name: z.string().optional().describe("Optional case-insensitive display-name filter"),
  },
  handler: async ({ workspace, name }) => {
    const ws = await resolveWorkspace(workspace);
    let databases = await fabricListAll(`/workspaces/${ws.id}/sqlDatabases`);
    if (name) {
      databases = databases.filter((database) => (database.displayName ?? "").toLowerCase().includes(name.toLowerCase()));
    }
    return {
      workspace: wsOut(ws),
      count: databases.length,
      databases: databases.map((database) => ({
        id: database.id,
        displayName: database.displayName,
        description: database.description,
        serverFqdn: database.properties?.serverFqdn,
        databaseName: database.properties?.databaseName,
        connectionString: database.properties?.connectionString,
      })),
    };
  },
});

const addWorkspaceRole = defineTool({
  name: "add_workspace_role",
  mode: "write",
  description:
    "Grant a principal (user, group, or service principal) a role on a Fabric workspace. Roles: Admin, Member, Contributor, Viewer. Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    principal_id: z.string().describe("Object ID of the principal to grant access to"),
    principal_type: z
      .string()
      .optional()
      .describe("Principal type: User, Group, ServicePrincipal, or ServicePrincipalProfile (default ServicePrincipal)"),
    role: z.string().describe("Role to grant: Admin, Member, Contributor, or Viewer"),
  },
  handler: async ({ workspace, principal_id, principal_type, role }) => {
    const ws = await resolveWorkspace(workspace);
    const principal = { id: principal_id, type: principal_type ?? "ServicePrincipal" };
    const data = await fabric("POST", `/workspaces/${ws.id}/roleAssignments`, { principal, role });
    audit("add_workspace_role", { ws: ws.id, principal: principal_id, type: principal.type, role });
    return { workspace: wsOut(ws), granted: true, principal, role, result: data };
  },
});

const createFolder = defineTool({
  name: "create_folder",
  mode: "write",
  description:
    "Create a folder in a Fabric workspace, optionally under a parent folder. Idempotent: if a folder already exists at that location it is returned instead of erroring. Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    display_name: z.string().describe("Name for the new folder (a single segment, not a path)"),
    parent_folder: z
      .string()
      .optional()
      .describe("Parent folder as a full path (e.g. 'Reports/Sales'), unique name, or GUID. Omit for workspace root."),
  },
  handler: async ({ workspace, display_name, parent_folder }) => {
    const ws = await resolveWorkspace(workspace);
    const parent = parent_folder ? await resolveFolder(ws.id, parent_folder) : null;
    const existing = (await listFolders(ws.id)).find(
      (folder) =>
        folder.displayName.toLowerCase() === display_name.toLowerCase() &&
        (folder.parentFolderId ?? null) === (parent?.id ?? null),
    );
    if (existing) return { workspace: wsOut(ws), folder: existing, alreadyExisted: true };
    const body = { displayName: display_name, ...(parent ? { parentFolderId: parent.id } : {}) };
    const data = await fabric("POST", `/workspaces/${ws.id}/folders`, body);
    audit("create_folder", { ws: ws.id, name: display_name, parent: parent?.id ?? "root" });
    return {
      workspace: wsOut(ws),
      folder: {
        id: data.id,
        displayName: data.displayName,
        parentFolderId: data.parentFolderId ?? null,
        path: parent ? `${parent.path ?? parent.id}/${data.displayName}` : data.displayName,
      },
      alreadyExisted: false,
    };
  },
});

const moveItem = defineTool({
  name: "move_item",
  mode: "write",
  description:
    "Move a Fabric item into a workspace folder (or back to the workspace root). Changes only the item's location — its definition, ID, and schedules are untouched. Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Item display name or GUID"),
    type: z.string().optional().describe("Item type to disambiguate the name, e.g. Report, PaginatedReport"),
    target_folder: z
      .string()
      .optional()
      .describe("Destination folder as a full path (e.g. 'Reports/Sales'), unique name, or GUID. Omit to move to the workspace root."),
  },
  handler: async ({ workspace, item, type, target_folder }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const target = target_folder ? await resolveFolder(ws.id, target_folder) : null;
    await fabric("POST", `/workspaces/${ws.id}/items/${it.id}/move`, target ? { targetFolderId: target.id } : {});
    audit("move_item", { ws: ws.id, item: it.id, target: target?.id ?? "root" });
    return {
      workspace: wsOut(ws),
      item: itemOut(it, item),
      movedTo: target ? { id: target.id, path: target.path ?? target.id } : "root",
    };
  },
});

const deleteFolder = defineTool({
  name: "delete_folder",
  mode: "write",
  description:
    "Delete an EMPTY folder from a Fabric workspace (the API rejects folders that still contain items or subfolders — move them out first). Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    folder: z.string().describe("Folder as a full path (e.g. 'Reports/zz_old_Sales'), unique name, or GUID"),
  },
  handler: async ({ workspace, folder }) => {
    const ws = await resolveWorkspace(workspace);
    const target = await resolveFolder(ws.id, folder);
    await fabric("DELETE", `/workspaces/${ws.id}/folders/${target.id}`);
    audit("delete_folder", { ws: ws.id, folder: target.id });
    return { workspace: wsOut(ws), folder: { id: target.id, path: target.path ?? target.id }, deleted: true };
  },
});

export default [
  listWorkspaces,
  listItems,
  listFoldersTool,
  listWorkspaceRoles,
  listSqlDatabases,
  addWorkspaceRole,
  createFolder,
  moveItem,
  deleteFolder,
];
