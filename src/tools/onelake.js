import { z } from "zod";
import { normalizeOneLakeFilePath } from "../fabric/files.js";
import { resolveItem, resolveWorkspace } from "../fabric/resolvers.js";
import { onelake } from "../http/client.js";
import { defineTool, itemOut, wsOut } from "./define.js";

const workspaceField = z.string().describe("Workspace display name or GUID");

const listOnelake = defineTool({
  name: "list_onelake",
  description:
    "List files/folders under a Fabric item in OneLake via the DFS API — lag-free ground truth for 'did this table/file land yet?' (the SQL analytics endpoint's metadata can lag minutes behind actual writes; see refresh_sql_endpoint_metadata). Defaults to the item's Delta tables under the default schema. Accepts workspace + item by display name or GUID.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Lakehouse/warehouse/item display name or GUID"),
    type: z.string().optional().describe("Item type to disambiguate the name, e.g. Lakehouse, Warehouse"),
    directory: z
      .string()
      .optional()
      .describe("Directory under the item to list, e.g. 'Tables/dbo' (default), 'Tables/<schema>', 'Files'"),
    recursive: z.boolean().optional().describe("Recurse into subdirectories (default false)"),
  },
  handler: async ({ workspace, item, type, directory, recursive }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const dir = directory ?? "Tables/dbo";
    const data = await onelake("GET", `/${ws.id}`, {
      query: { resource: "filesystem", recursive: recursive ? "true" : "false", directory: `${it.id}/${dir}` },
    });
    const paths = (data.paths ?? []).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory === "true" || entry.isDirectory === true,
      contentLength: entry.contentLength != null ? Number(entry.contentLength) : undefined,
      lastModified: entry.lastModified,
    }));
    return { workspace: wsOut(ws), item: itemOut(it, item), directory: dir, count: paths.length, paths };
  },
});

const readOnelakeFile = defineTool({
  name: "read_onelake_file",
  description:
    "Read a small file from a Fabric item's OneLake storage (e.g. a notebook output, log, or JSON result under Files/). Downloads and returns decoded text capped by bytes. Accepts workspace + item by display name or GUID.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Item display name or GUID"),
    type: z.string().optional().describe("Item type to disambiguate the name"),
    path: z.string().describe("File path under the item, e.g. 'Files/output/summary.json'"),
    max_bytes: z.number().int().positive().max(1_000_000).optional().describe("Max response bytes to return (default 100000)"),
  },
  handler: async ({ workspace, item, type, path, max_bytes }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const cap = max_bytes ?? 100_000;
    const filePath = normalizeOneLakeFilePath(path);
    const result = await onelake("GET", `/${ws.id}/${it.id}/${filePath}`, { raw: true, maxBytes: cap });
    return {
      workspace: wsOut(ws),
      item: itemOut(it, item),
      path,
      length: result.text.length,
      bytesRead: result.bytesRead,
      totalBytes: result.totalBytes,
      truncated: result.truncated,
      content: result.text,
    };
  },
});

export default [listOnelake, readOnelakeFile];
