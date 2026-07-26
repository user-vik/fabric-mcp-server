import { z } from "zod";
import { WRITE_ENABLED } from "../config.js";
import { readDefinitionFromDir, readSnapshot, writeSnapshot } from "../fabric/files.js";
import {
  GUID_RE,
  resolveDataset,
  resolveDeploymentPipeline,
  resolveItem,
  resolvePipeline,
  resolveWorkspace,
} from "../fabric/resolvers.js";
import { fabric, fabricListAll, powerbi } from "../http/client.js";
import { fabricLro, pollJobInstance, summarizeRun } from "../http/polling.js";
import { ok, safeTool } from "./tool-utils.js";

const WRITE_MODE_MESSAGE =
  "[fabric-mcp] write mode enabled — run_pipeline, cancel_pipeline_run, refresh_dataset, update_from_git, update_item_definition, create_schedule, update_schedule, delete_schedule, deploy_stage, run_notebook, create_item, delete_item, add_workspace_role exposed";

function registerWriteTools(server) {
  if (!WRITE_ENABLED) return;

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
      const pipelineInfo = await resolvePipeline(ws.id, pipeline);
      const body = parameters ? { executionData: { parameters } } : undefined;
      const data = await fabric(
        "POST",
        `/workspaces/${ws.id}/items/${pipelineInfo.id}/jobs/instances`,
        body,
        { jobType: "Pipeline" },
      );
      console.error(`[fabric-mcp][AUDIT] ${new Date().toISOString()} run_pipeline ws=${ws.id} item=${pipelineInfo.id}`);
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
      const pipelineInfo = await resolvePipeline(ws.id, pipeline);
      const data = await fabric(
        "POST",
        `/workspaces/${ws.id}/items/${pipelineInfo.id}/jobs/instances/${encodeURIComponent(job_instance_id)}/cancel`,
      );
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} cancel_pipeline_run ws=${ws.id} item=${pipelineInfo.id} job=${job_instance_id}`,
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
      const data = await powerbi("POST", `/groups/${ws.id}/datasets/${ds.id}/refreshes`, {
        notifyOption: "NoNotification",
      });
      console.error(`[fabric-mcp][AUDIT] ${new Date().toISOString()} refresh_dataset ws=${ws.id} dataset=${ds.id}`);
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
      if (!definition_path && !restore_snapshot) {
        throw new Error("Provide either definition_path (folder to deploy) or restore_snapshot (JSON to roll back).");
      }
      if (definition_path && restore_snapshot) {
        throw new Error("Provide only one of definition_path or restore_snapshot.");
      }
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
      const jobType = job_type ?? "Pipeline";
      const body = { enabled: enabled ?? true, configuration };
      const data = await fabric(
        "POST",
        `/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jobType)}/schedules`,
        body,
      );
      console.error(`[fabric-mcp][AUDIT] ${new Date().toISOString()} create_schedule ws=${ws.id} item=${it.id} jobType=${jobType}`);
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
        jobType,
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
      const jobType = job_type ?? "Pipeline";
      const base = `/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jobType)}/schedules/${encodeURIComponent(schedule_id)}`;
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
        jobType,
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
      const jobType = job_type ?? "Pipeline";
      const base = `/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jobType)}/schedules/${encodeURIComponent(schedule_id)}`;
      let snapshotPath = null;
      try {
        const current = await fabric("GET", base);
        snapshotPath = writeSnapshot(`schedule-${schedule_id}`, current);
      } catch (error) {
        console.error(`[fabric-mcp] schedule snapshot skipped for ${schedule_id}: ${error.message}`);
      }
      await fabric("DELETE", base);
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} delete_schedule ws=${ws.id} item=${it.id} schedule=${schedule_id} snapshot=${snapshotPath ?? "none"}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: { id: it.id, displayName: it.displayName ?? item, type: it.type },
        jobType,
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
      const findStage = (stage) =>
        stages.find((entry) =>
          GUID_RE.test(stage)
            ? entry.id === stage
            : (entry.displayName ?? "").toLowerCase() === stage.toLowerCase(),
        );
      const src = findStage(source_stage);
      const tgt = findStage(target_stage);
      if (!src) {
        throw new Error(`Source stage "${source_stage}" not found. Stages: ${stages.map((entry) => entry.displayName).join(", ")}`);
      }
      if (!tgt) {
        throw new Error(`Target stage "${target_stage}" not found. Stages: ${stages.map((entry) => entry.displayName).join(", ")}`);
      }
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
      const data = await fabric("POST", `/workspaces/${ws.id}/items/${nb.id}/jobs/instances`, body, {
        jobType: "RunNotebook",
      });
      console.error(`[fabric-mcp][AUDIT] ${new Date().toISOString()} run_notebook ws=${ws.id} item=${nb.id}`);
      const operationLocation = data._location ?? null;
      if ((wait ?? true) && operationLocation) {
        const retryAfter = data._retryAfter ? parseInt(data._retryAfter, 10) : undefined;
        const finalState = await pollJobInstance(operationLocation, retryAfter);
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
        operationLocation,
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
      console.error(`[fabric-mcp][AUDIT] ${new Date().toISOString()} create_item ws=${ws.id} type=${type} name=${display_name}`);
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
      const path = isDataflow ? `/workspaces/${ws.id}/dataflows/${it.id}` : `/workspaces/${ws.id}/items/${it.id}`;
      await fabric("DELETE", path);
      console.error(
        `[fabric-mcp][AUDIT] ${new Date().toISOString()} delete_item ws=${ws.id} item=${it.id} type=${itemType ?? "?"} snapshot=${snapshotPath ?? "none"}`,
      );
      return ok({
        workspace: { id: ws.id, displayName: ws.displayName },
        item: { id: it.id, displayName: it.displayName ?? item, type: itemType },
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

export { WRITE_MODE_MESSAGE, registerWriteTools };
