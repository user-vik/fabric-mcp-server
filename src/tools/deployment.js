import { z } from "zod";
import { GUID_RE, resolveDeploymentPipeline } from "../fabric/resolvers.js";
import { fabricListAll } from "../http/client.js";
import { fabricLro } from "../http/polling.js";
import { audit, defineTool } from "./define.js";

const findStage = (stages, stage) =>
  stages.find((entry) => (GUID_RE.test(stage) ? entry.id === stage : (entry.displayName ?? "").toLowerCase() === stage.toLowerCase()));

const listDeploymentPipelines = defineTool({
  name: "list_deployment_pipelines",
  description:
    "List the Fabric deployment pipelines the signed-in identity can see — used to promote item definitions across stages (e.g. Dev -> Test -> Prod).",
  handler: async () => {
    const all = await fabricListAll("/deploymentPipelines");
    return all.map((pipeline) => ({ id: pipeline.id, displayName: pipeline.displayName, description: pipeline.description }));
  },
});

const listDeploymentStages = defineTool({
  name: "list_deployment_stages",
  description:
    "List the stages of a Fabric deployment pipeline (order, display name, assigned workspace). Pass 'stage' to also return that stage's items — the source item IDs + types you feed to deploy_stage. Accepts the deployment pipeline (and optional stage) by display name or GUID.",
  schema: {
    deployment_pipeline: z.string().describe("Deployment pipeline display name or GUID"),
    stage: z.string().optional().describe("Optional stage display name or GUID to also list that stage's items"),
  },
  handler: async ({ deployment_pipeline, stage }) => {
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
      const match = findStage(stages, stage);
      if (!match) throw new Error(`Stage "${stage}" not found. Stages: ${stages.map((entry) => entry.displayName).join(", ")}`);
      const items = await fabricListAll(`/deploymentPipelines/${dp.id}/stages/${match.id}/items`);
      result.stageItems = {
        stage: { id: match.id, displayName: match.displayName },
        count: items.length,
        items: items.map((item) => ({ sourceItemId: item.itemId, itemDisplayName: item.itemDisplayName, itemType: item.itemType })),
      };
    }
    return result;
  },
});

const deployStage = defineTool({
  name: "deploy_stage",
  mode: "write",
  description:
    "Selectively deploy items from one deployment-pipeline stage to the next (e.g. Dev -> Test). You MUST pass an explicit item list — this tool refuses an empty list so a blanket 'deploy everything' can't happen by accident. Long-running: polls to completion. NOTE: a deploy carries each item's schedule definition and recreates schedules under the CALLER's identity, and it repoints item references to the target stage but does NOT rebind data-source connections — a deployed semantic model comes out with connectivityType Automatic and will not refresh until bind_semantic_model_connection is run (check with get_item_connections and list_schedules). Requires FABRIC_MCP_MODE=write.",
  schema: {
    deployment_pipeline: z.string().describe("Deployment pipeline display name or GUID"),
    source_stage: z.string().describe("Source stage display name or GUID"),
    target_stage: z.string().describe("Target stage display name or GUID"),
    items: z
      .array(z.object({ sourceItemId: z.string(), itemType: z.string() }))
      .min(1)
      .describe("Items to deploy: [{ sourceItemId, itemType }], from list_deployment_stages stage items"),
    note: z.string().optional().describe("Optional deployment note"),
  },
  handler: async ({ deployment_pipeline, source_stage, target_stage, items, note }) => {
    const dp = await resolveDeploymentPipeline(deployment_pipeline);
    const stages = await fabricListAll(`/deploymentPipelines/${dp.id}/stages`);
    const src = findStage(stages, source_stage);
    const tgt = findStage(stages, target_stage);
    const names = stages.map((entry) => entry.displayName).join(", ");
    if (!src) throw new Error(`Source stage "${source_stage}" not found. Stages: ${names}`);
    if (!tgt) throw new Error(`Target stage "${target_stage}" not found. Stages: ${names}`);
    const body = { sourceStageId: src.id, targetStageId: tgt.id, items, ...(note ? { note } : {}) };
    const data = await fabricLro("POST", `/deploymentPipelines/${dp.id}/deploy`, body);
    audit("deploy_stage", { dp: dp.id, src: src.id, tgt: tgt.id, items: items.length });
    return {
      deploymentPipeline: { id: dp.id, displayName: dp.displayName ?? deployment_pipeline },
      source: { id: src.id, displayName: src.displayName },
      target: { id: tgt.id, displayName: tgt.displayName },
      itemsDeployed: items.length,
      result: data,
    };
  },
});

export default [listDeploymentPipelines, listDeploymentStages, deployStage];
