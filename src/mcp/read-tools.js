import { z } from "zod";
import { normalizeOneLakeFilePath } from "../fabric/files.js";
import { listFolders } from "../fabric/folders.js";
import {
  GUID_RE,
  resolveDataset,
  resolveDeploymentPipeline,
  resolveItem,
  resolvePipeline,
  resolveWorkspace,
} from "../fabric/resolvers.js";
import { fabric, fabricListAll, onelake, powerbi } from "../http/client.js";
import { fabricLro, summarizeRun } from "../http/polling.js";
import { ok, safeTool } from "./tool-utils.js";

function registerReadTools(server) {
  server.registerTool(
    "list_workspaces",
    {
      description: "List all Microsoft Fabric workspaces the signed-in identity can see.",
      inputSchema: {},
    },
    safeTool(async () => {
      const all = await fabricListAll("/workspaces");
      return ok(all.map((workspace) => ({ id: workspace.id, displayName: workspace.displayName, capacityId: workspace.capacityId })));
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
        pipelines: items.map((item) => ({
          id: item.id,
          displayName: item.displayName,
          description: item.description,
        })),
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
      const pipelineInfo = await resolvePipeline(ws.id, pipeline);
      const runs = await fabricListAll(`/workspaces/${ws.id}/items/${pipelineInfo.id}/jobs/instances`);
      let mapped = runs.map(summarizeRun);
      if (status) mapped = mapped.filter((run) => (run.status ?? "").toLowerCase() === status.toLowerCase());
      mapped.sort((a, b) => new Date(b.startTimeUtc ?? 0) - new Date(a.startTimeUtc ?? 0));
      const limit = top ?? 25;
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        pipeline: { id: pipelineInfo.id, displayName: pipelineInfo.displayName ?? pipeline },
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
      const pipelineInfo = await resolvePipeline(ws.id, pipeline);
      const data = await fabric(
        "GET",
        `/workspaces/${ws.id}/items/${pipelineInfo.id}/jobs/instances/${encodeURIComponent(job_instance_id)}`,
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
      const data = await powerbi("POST", `/groups/${ws.id}/datasets/${ds.id}/executeQueries`, body);
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
        items: items.map((item) => ({
          id: item.id,
          type: item.type,
          displayName: item.displayName,
          description: item.description,
          ...(item.folderId ? { folderId: item.folderId } : {}),
        })),
      });
    }),
  );

  server.registerTool(
    "list_folders",
    {
      description:
        "List the folders in a Fabric workspace as a flat list with full paths (e.g. 'Reports/Sales'). Use to inspect or verify workspace folder structure — items reference their folder via folderId (see list_items). Accepts workspace by display name or GUID.",
      inputSchema: {
        workspace: z.string().describe("Workspace display name or GUID"),
      },
    },
    safeTool(async ({ workspace }) => {
      const ws = await resolveWorkspace(workspace);
      const folders = await listFolders(ws.id);
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        count: folders.length,
        folders,
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
      const data = await powerbi("GET", `/groups/${ws.id}/datasets/${ds.id}/refreshes`, null, { $top: top ?? 20 });
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
        format: z.string().optional().describe("Optional definition format, e.g. 'ipynb' for notebooks"),
        part: z.string().optional().describe("A part path (from the manifest) to return decoded to text"),
      },
    },
    safeTool(async ({ workspace, item, type, format, part }) => {
      const ws = await resolveWorkspace(workspace);
      const itemInfo = await resolveItem(ws.id, item, type);
      const query = format ? `?format=${encodeURIComponent(format)}` : "";
      const data = await fabricLro("POST", `/workspaces/${ws.id}/items/${itemInfo.id}/getDefinition${query}`);
      const parts = data?.definition?.parts ?? [];
      const itemResult = { id: itemInfo.id, displayName: itemInfo.displayName ?? item, type: itemInfo.type };
      if (part) {
        const selected = parts.find((entry) => entry.path === part);
        if (!selected) throw new Error(`Part "${part}" not found. Parts: ${parts.map((entry) => entry.path).join(", ")}`);
        const content =
          selected.payloadType === "InlineBase64"
            ? Buffer.from(selected.payload ?? "", "base64").toString("utf8")
            : `(non-base64 payloadType: ${selected.payloadType})`;
        return ok({
          workspace: { id: ws.id, displayName: ws.displayName },
          item: itemResult,
          part: { path: selected.path, payloadType: selected.payloadType, content },
        });
      }
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: itemResult,
        partCount: parts.length,
        parts: parts.map((entry) => ({
          path: entry.path,
          payloadType: entry.payloadType,
          base64Length: (entry.payload ?? "").length,
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
        type: z.string().optional().describe("Item type to disambiguate the name, e.g. DataPipeline, Notebook"),
        job_type: z
          .string()
          .optional()
          .describe("Schedule job type (default 'Pipeline'; use 'RunNotebook' for notebooks)"),
      },
    },
    safeTool(async ({ workspace, item, type, job_type }) => {
      const ws = await resolveWorkspace(workspace);
      const it = await resolveItem(ws.id, item, type);
      const jobType = job_type ?? "Pipeline";
      const schedules = await fabricListAll(`/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jobType)}/schedules`);
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
        jobType,
        schedules: schedules.map((schedule) => ({
          id: schedule.id,
          enabled: schedule.enabled,
          owner: schedule.owner ? { id: schedule.owner.id, type: schedule.owner.type } : null,
          createdDateTime: schedule.createdDateTime,
          configuration: schedule.configuration,
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
      return ok(all.map((pipeline) => ({ id: pipeline.id, displayName: pipeline.displayName, description: pipeline.description })));
    }),
  );

  server.registerTool(
    "list_deployment_stages",
    {
      description:
        "List the stages of a Fabric deployment pipeline (order, display name, assigned workspace). Pass 'stage' to also return that stage's items — the source item IDs + types you feed to deploy_stage. Accepts the deployment pipeline (and optional stage) by display name or GUID.",
      inputSchema: {
        deployment_pipeline: z.string().describe("Deployment pipeline display name or GUID"),
        stage: z.string().optional().describe("Optional stage display name or GUID to also list that stage's items"),
      },
    },
    safeTool(async ({ deployment_pipeline, stage }) => {
      const dp = await resolveDeploymentPipeline(deployment_pipeline);
      const stages = await fabricListAll(`/deploymentPipelines/${dp.id}/stages`);
      const result = {
        deploymentPipeline: { id: dp.id, displayName: dp.displayName ?? deployment_pipeline },
        stages: stages.map((entry) => ({
          id: entry.id,
          order: entry.order,
          displayName: entry.displayName,
          workspaceId: entry.workspaceId,
          workspaceName: entry.workspaceName,
          isPublic: entry.isPublic,
        })),
      };
      if (stage) {
        const match = stages.find((entry) =>
          GUID_RE.test(stage) ? entry.id === stage : (entry.displayName ?? "").toLowerCase() === stage.toLowerCase(),
        );
        if (!match) {
          throw new Error(`Stage "${stage}" not found. Stages: ${stages.map((entry) => entry.displayName).join(", ")}`);
        }
        const items = await fabricListAll(`/deploymentPipelines/${dp.id}/stages/${match.id}/items`);
        result.stageItems = {
          stage: { id: match.id, displayName: match.displayName },
          items: items.map((item) => ({
            sourceItemId: item.itemId,
            itemDisplayName: item.itemDisplayName,
            itemType: item.itemType,
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
      const paths = (data.paths ?? []).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory === "true" || entry.isDirectory === true,
        contentLength: entry.contentLength != null ? Number(entry.contentLength) : undefined,
        lastModified: entry.lastModified,
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
        "Read a small file from a Fabric item's OneLake storage (e.g. a notebook output, log, or JSON result under Files/). Downloads and returns decoded text capped by bytes. Accepts workspace + item by display name or GUID.",
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
          .describe("Max response bytes to return (default 100000)"),
      },
    },
    safeTool(async ({ workspace, item, type, path, max_bytes }) => {
      const ws = await resolveWorkspace(workspace);
      const it = await resolveItem(ws.id, item, type);
      const cap = max_bytes ?? 100_000;
      const filePath = normalizeOneLakeFilePath(path);
      const result = await onelake("GET", `/${ws.id}/${it.id}/${filePath}`, {
        raw: true,
        maxBytes: cap,
      });
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
        path,
        length: result.text.length,
        bytesRead: result.bytesRead,
        totalBytes: result.totalBytes,
        truncated: result.truncated,
        content: result.text,
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
        roleAssignments: roles.map((role) => ({
          id: role.id,
          role: role.role,
          principal: role.principal
            ? { id: role.principal.id, displayName: role.principal.displayName, type: role.principal.type }
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
      let databases = await fabricListAll(`/workspaces/${ws.id}/sqlDatabases`);
      if (name) {
        databases = databases.filter((database) =>
          (database.displayName ?? "").toLowerCase().includes(name.toLowerCase()),
        );
      }
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        count: databases.length,
        databases: databases.map((database) => ({
          id: database.id,
          displayName: database.displayName,
          description: database.description,
          serverFqdn: database.properties?.serverFqdn,
          databaseName: database.properties?.databaseName,
          connectionString: database.properties?.connectionString,
        })),
      });
    }),
  );
}

export { registerReadTools };
