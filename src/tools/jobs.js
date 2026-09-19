import { z } from "zod";
import { writeSnapshot } from "../fabric/files.js";
import { resolveItem, resolvePipeline, resolveWorkspace } from "../fabric/resolvers.js";
import { FABRIC_BASE } from "../config.js";
import { fabric, fabricListAll } from "../http/client.js";
import { TERMINAL_JOB_STATUSES, jobInstanceIdFrom, pollJobInstance, summarizeRun } from "../http/polling.js";
import { audit, defineTool, itemOut, wsOut } from "./define.js";

const workspaceField = z.string().describe("Workspace display name or GUID");
const pipelineField = z.string().describe("Data pipeline display name or GUID");

function sortRuns(runs, { status, job_type, top, defaultTop = 25 }) {
  let mapped = runs.map(summarizeRun);
  if (status) mapped = mapped.filter((run) => (run.status ?? "").toLowerCase() === status.toLowerCase());
  if (job_type) mapped = mapped.filter((run) => (run.jobType ?? "").toLowerCase() === job_type.toLowerCase());
  mapped.sort((a, b) => new Date(b.startTimeUtc ?? 0) - new Date(a.startTimeUtc ?? 0));
  const limit = top ?? defaultTop;
  return { returned: Math.min(limit, mapped.length), totalFetched: mapped.length, runs: mapped.slice(0, limit) };
}

const listPipelines = defineTool({
  name: "list_pipelines",
  description: 'List the data pipelines in a Fabric workspace. Accepts a workspace display name (e.g. "My-Workspace") or GUID.',
  schema: { workspace: workspaceField },
  handler: async ({ workspace }) => {
    const ws = await resolveWorkspace(workspace);
    const items = await fabricListAll(`/workspaces/${ws.id}/items?type=DataPipeline`);
    return {
      workspace: wsOut(ws),
      pipelines: items.map((item) => ({ id: item.id, displayName: item.displayName, description: item.description })),
    };
  },
});

const listPipelineRuns = defineTool({
  name: "list_pipeline_runs",
  description:
    "List run (job instance) history for a Fabric data pipeline, most-recent first. Accepts workspace + pipeline by display name or GUID. Use this for 'how did my pipeline run last night' style questions.",
  schema: {
    workspace: workspaceField,
    pipeline: pipelineField,
    status: z.string().optional().describe("Client-side filter on status, e.g. Completed, Failed, InProgress, Cancelled"),
    top: z.number().int().positive().max(200).optional().describe("Max runs to return (default 25)"),
  },
  handler: async ({ workspace, pipeline, status, top }) => {
    const ws = await resolveWorkspace(workspace);
    const pipelineInfo = await resolvePipeline(ws.id, pipeline);
    const runs = await fabricListAll(`/workspaces/${ws.id}/items/${pipelineInfo.id}/jobs/instances`);
    return {
      workspace: wsOut(ws),
      pipeline: { id: pipelineInfo.id, displayName: pipelineInfo.displayName ?? pipeline },
      ...sortRuns(runs, { status, top }),
    };
  },
});

const getPipelineRun = defineTool({
  name: "get_pipeline_run",
  description:
    "Get full detail for a single pipeline run (job instance) by its ID, including failureReason. Use after list_pipeline_runs to drill into a failure.",
  schema: {
    workspace: workspaceField,
    pipeline: pipelineField,
    job_instance_id: z.string().describe("The job instance ID from list_pipeline_runs"),
  },
  handler: async ({ workspace, pipeline, job_instance_id }) => {
    const ws = await resolveWorkspace(workspace);
    const pipelineInfo = await resolvePipeline(ws.id, pipeline);
    return fabric("GET", `/workspaces/${ws.id}/items/${pipelineInfo.id}/jobs/instances/${encodeURIComponent(job_instance_id)}`);
  },
});

const listItemRuns = defineTool({
  name: "list_item_runs",
  description:
    "List job instances (runs) for any Fabric item that runs as a job — notebooks, Spark job definitions, dataflows, pipelines — most-recent first, with status, duration and failureReason. Use after a detached run_notebook to answer 'how did that run go'. Items without jobs (semantic models, reports) return ItemNotFound from the API; use get_refresh_history for model refreshes. Accepts workspace + item by display name or GUID.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Item display name or GUID"),
    type: z.string().optional().describe("Item type to disambiguate the name, e.g. Notebook, SparkJobDefinition, DataPipeline"),
    job_type: z.string().optional().describe("Client-side filter on job type, e.g. RunNotebook, Pipeline"),
    status: z.string().optional().describe("Client-side filter on status, e.g. Completed, Failed, InProgress, Cancelled, Deduped"),
    top: z.number().int().positive().max(200).optional().describe("Max runs to return (default 25)"),
  },
  handler: async ({ workspace, item, type, job_type, status, top }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const runs = await fabricListAll(`/workspaces/${ws.id}/items/${it.id}/jobs/instances`);
    return { workspace: wsOut(ws), item: itemOut(it, item), ...sortRuns(runs, { status, job_type, top }) };
  },
});

const getItemRun = defineTool({
  name: "get_item_run",
  description:
    "Get one job instance (run) of any Fabric item by its job instance ID — terminal status, timings, and full failureReason. Pair with list_item_runs, or with the jobInstanceId returned by a detached run_notebook.",
  schema: {
    workspace: workspaceField,
    item: z.string().describe("Item display name or GUID"),
    type: z.string().optional().describe("Item type to disambiguate the name"),
    job_instance_id: z.string().describe("The job instance ID"),
  },
  handler: async ({ workspace, item, type, job_instance_id }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const data = await fabric("GET", `/workspaces/${ws.id}/items/${it.id}/jobs/instances/${encodeURIComponent(job_instance_id)}`);
    return { workspace: wsOut(ws), item: itemOut(it, item), run: summarizeRun(data), raw: data };
  },
});

const runPipeline = defineTool({
  name: "run_pipeline",
  mode: "write",
  description:
    "Trigger an on-demand run of a Fabric data pipeline. Returns the accepted operation location and jobInstanceId (track it with get_pipeline_run). Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    pipeline: pipelineField,
    parameters: z.record(z.any()).optional().describe("Optional executionData.parameters object passed to the pipeline"),
  },
  handler: async ({ workspace, pipeline, parameters }) => {
    const ws = await resolveWorkspace(workspace);
    const pipelineInfo = await resolvePipeline(ws.id, pipeline);
    const body = parameters ? { executionData: { parameters } } : undefined;
    const data = await fabric("POST", `/workspaces/${ws.id}/items/${pipelineInfo.id}/jobs/instances`, body, { jobType: "Pipeline" });
    audit("run_pipeline", { ws: ws.id, item: pipelineInfo.id });
    return {
      accepted: true,
      jobInstanceId: jobInstanceIdFrom(data._location),
      operationLocation: data._location ?? null,
      raw: data,
    };
  },
});

const cancelPipelineRun = defineTool({
  name: "cancel_pipeline_run",
  mode: "write",
  description: "Cancel an in-progress pipeline run (job instance). Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    pipeline: pipelineField,
    job_instance_id: z.string().describe("The job instance ID to cancel"),
  },
  handler: async ({ workspace, pipeline, job_instance_id }) => {
    const ws = await resolveWorkspace(workspace);
    const pipelineInfo = await resolvePipeline(ws.id, pipeline);
    const data = await fabric(
      "POST",
      `/workspaces/${ws.id}/items/${pipelineInfo.id}/jobs/instances/${encodeURIComponent(job_instance_id)}/cancel`,
    );
    audit("cancel_pipeline_run", { ws: ws.id, item: pipelineInfo.id, job: job_instance_id });
    return { cancelRequested: true, operationLocation: data._location ?? null };
  },
});

const DETACHED_NOTE =
  "Run started and detached. Track it with get_item_run (or run_notebook with job_instance_id set and wait=true). Calling run_notebook again WITHOUT job_instance_id starts a SECOND run.";

const runNotebook = defineTool({
  name: "run_notebook",
  mode: "write",
  description:
    "Run a Fabric notebook on demand as a job. By default waits for a terminal status and returns a run summary; set wait=false to return immediately with the jobInstanceId. To attach to a run that is already going, pass job_instance_id (no new run is started). NOTE: executionData.parameters only inject when the notebook exposes a properly TAGGED parameters cell (ipynb format). A notebook that marks its parameters cell with a '# PARAMETERS_CELL' comment silently ignores injected values and runs with its in-source defaults while still reporting success. Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    notebook: z.string().describe("Notebook display name or GUID"),
    parameters: z.record(z.any()).optional().describe("Typed parameters, e.g. { myParam: { value: '5', type: 'int' } }"),
    configuration: z
      .record(z.any())
      .optional()
      .describe("Optional executionData.configuration (Spark conf, environment, defaultLakehouse, ...)"),
    wait: z.boolean().optional().describe("Wait for terminal status (default true)"),
    job_instance_id: z
      .string()
      .optional()
      .describe("Attach to an EXISTING job instance instead of starting a new run (poll it when wait=true, or just report its status)"),
  },
  handler: async ({ workspace, notebook, parameters, configuration, wait, job_instance_id }) => {
    const ws = await resolveWorkspace(workspace);
    const nb = await resolveItem(ws.id, notebook, "Notebook");
    const shouldWait = wait ?? true;
    const notebookOut = { id: nb.id, displayName: nb.displayName ?? notebook };

    if (job_instance_id) {
      const instancePath = `/workspaces/${ws.id}/items/${nb.id}/jobs/instances/${encodeURIComponent(job_instance_id)}`;
      const current = await fabric("GET", instancePath);
      const terminal = TERMINAL_JOB_STATUSES.has((current.status ?? "").toLowerCase());
      if (!shouldWait || terminal) {
        return { workspace: wsOut(ws), notebook: notebookOut, attached: true, jobInstanceId: job_instance_id, run: summarizeRun(current) };
      }
      const finalState = await pollJobInstance(`${FABRIC_BASE}${instancePath}`);
      return { workspace: wsOut(ws), notebook: notebookOut, attached: true, jobInstanceId: job_instance_id, run: summarizeRun(finalState) };
    }

    const executionData = {};
    if (parameters) executionData.parameters = parameters;
    if (configuration) executionData.configuration = configuration;
    const body = Object.keys(executionData).length ? { executionData } : undefined;
    const data = await fabric("POST", `/workspaces/${ws.id}/items/${nb.id}/jobs/instances`, body, { jobType: "RunNotebook" });
    audit("run_notebook", { ws: ws.id, item: nb.id });
    const operationLocation = data._location ?? null;
    const jobInstanceId = jobInstanceIdFrom(operationLocation);
    if (shouldWait && operationLocation) {
      const retryAfter = data._retryAfter ? parseInt(data._retryAfter, 10) : undefined;
      const finalState = await pollJobInstance(operationLocation, retryAfter);
      return { workspace: wsOut(ws), notebook: notebookOut, jobInstanceId, run: summarizeRun(finalState) };
    }
    return { workspace: wsOut(ws), notebook: notebookOut, accepted: true, jobInstanceId, operationLocation, note: DETACHED_NOTE };
  },
});

const scheduleItemFields = {
  workspace: workspaceField,
  item: z.string().describe("Item display name or GUID"),
  type: z.string().optional().describe("Item type to disambiguate the name, e.g. DataPipeline, Notebook"),
  job_type: z.string().optional().describe("Schedule job type (default 'Pipeline'; 'RunNotebook' for notebooks)"),
};

const listSchedules = defineTool({
  name: "list_schedules",
  description:
    "List the job schedules on a Fabric item (data pipeline, notebook, ...), including each schedule's owner (id + type). Use the owner to detect ownership drift: deploying an item, or calling update_item_definition, recreates its schedules under the CALLER's identity — so a schedule you expect to be service-principal-owned can silently flip to a user. Accepts workspace + item by display name or GUID.",
  schema: scheduleItemFields,
  handler: async ({ workspace, item, type, job_type }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const jobType = job_type ?? "Pipeline";
    const schedules = await fabricListAll(`/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jobType)}/schedules`);
    return {
      workspace: wsOut(ws),
      item: itemOut(it, item),
      jobType,
      schedules: schedules.map((schedule) => ({
        id: schedule.id,
        enabled: schedule.enabled,
        owner: schedule.owner ? { id: schedule.owner.id, type: schedule.owner.type } : null,
        createdDateTime: schedule.createdDateTime,
        configuration: schedule.configuration,
      })),
    };
  },
});

const createSchedule = defineTool({
  name: "create_schedule",
  mode: "write",
  description:
    "Create a job schedule on a Fabric item (data pipeline, notebook, ...). The schedule is owned by the identity that creates it. Requires FABRIC_MCP_MODE=write.",
  schema: {
    ...scheduleItemFields,
    enabled: z.boolean().optional().describe("Whether the schedule is enabled (default true)"),
    configuration: z
      .record(z.any())
      .describe(
        "Schedule configuration, e.g. { type: 'Daily', times: ['08:00','10:00'], localTimeZoneId: 'Eastern Standard Time', startDateTime: '2024-01-01T00:00:00' }. type is Cron | Daily | Weekly.",
      ),
  },
  handler: async ({ workspace, item, type, job_type, enabled, configuration }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const jobType = job_type ?? "Pipeline";
    const data = await fabric("POST", `/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jobType)}/schedules`, {
      enabled: enabled ?? true,
      configuration,
    });
    audit("create_schedule", { ws: ws.id, item: it.id, jobType });
    return { workspace: wsOut(ws), item: itemOut(it, item), jobType, created: true, schedule: data };
  },
});

const updateSchedule = defineTool({
  name: "update_schedule",
  mode: "write",
  description:
    "Update a job schedule on a Fabric item — enable/disable (pause/resume) or change its configuration. NOTE: a PATCH re-stamps the schedule's owner to the calling identity, so pausing/resuming a service-principal-owned schedule as a user flips its owner; recreate as the SPN afterward if ownership matters (see list_schedules). If you pass only 'enabled' or only 'configuration', the other is carried over from the current schedule. Requires FABRIC_MCP_MODE=write.",
  schema: {
    ...scheduleItemFields,
    schedule_id: z.string().describe("The schedule ID from list_schedules"),
    enabled: z.boolean().optional().describe("Enable/disable the schedule"),
    configuration: z.record(z.any()).optional().describe("Replacement schedule configuration object"),
  },
  handler: async ({ workspace, item, type, job_type, schedule_id, enabled, configuration }) => {
    const ws = await resolveWorkspace(workspace);
    const it = await resolveItem(ws.id, item, type);
    const jobType = job_type ?? "Pipeline";
    const base = `/workspaces/${ws.id}/items/${it.id}/jobs/${encodeURIComponent(jobType)}/schedules/${encodeURIComponent(schedule_id)}`;
    const current = await fabric("GET", base);
    const body = { enabled: enabled ?? current.enabled, configuration: configuration ?? current.configuration };
    const data = await fabric("PATCH", base, body);
    audit("update_schedule", { ws: ws.id, item: it.id, schedule: schedule_id, enabled: body.enabled });
    return { workspace: wsOut(ws), item: itemOut(it, item), jobType, updated: true, schedule: data };
  },
});

const deleteSchedule = defineTool({
  name: "delete_schedule",
  mode: "write",
  description:
    "Delete a job schedule from a Fabric item. Snapshots the schedule object to a local JSON first (returned as snapshotPath) for reference. Requires FABRIC_MCP_MODE=write.",
  schema: { ...scheduleItemFields, schedule_id: z.string().describe("The schedule ID from list_schedules") },
  handler: async ({ workspace, item, type, job_type, schedule_id }) => {
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
    audit("delete_schedule", { ws: ws.id, item: it.id, schedule: schedule_id, snapshot: snapshotPath ?? "none" });
    return { workspace: wsOut(ws), item: itemOut(it, item), jobType, deleted: true, snapshotPath };
  },
});

export { DETACHED_NOTE };
export default [
  listPipelines,
  listPipelineRuns,
  getPipelineRun,
  listItemRuns,
  getItemRun,
  runPipeline,
  cancelPipelineRun,
  runNotebook,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
];
