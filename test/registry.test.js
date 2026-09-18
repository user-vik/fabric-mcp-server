import assert from "node:assert/strict";
import test from "node:test";
import { READ_TOOLS, TOOLS, WRITE_TOOLS, getTool } from "../src/tools/index.js";
import { DETACHED_NOTE } from "../src/tools/jobs.js";
import { WRITE_MODE_MESSAGE, registerTools, wrapHandler } from "../src/mcp/register.js";

const V1_5_TOOLS = [
  "list_workspaces", "list_pipelines", "list_pipeline_runs", "get_pipeline_run", "execute_dax", "list_items",
  "list_folders", "get_refresh_history", "get_git_status", "get_item_definition", "list_schedules",
  "list_deployment_pipelines", "list_deployment_stages", "list_onelake", "read_onelake_file", "list_workspace_roles",
  "list_sql_databases", "run_pipeline", "cancel_pipeline_run", "refresh_dataset", "update_from_git",
  "update_item_definition", "create_schedule", "update_schedule", "delete_schedule", "deploy_stage", "run_notebook",
  "create_item", "delete_item", "add_workspace_role", "create_folder", "move_item", "delete_folder",
];

const NEW_IN_2_0 = [
  "list_item_runs", "get_item_run", "get_item_connections", "get_dataset_datasources",
  "commit_to_git", "refresh_sql_endpoint_metadata", "bind_semantic_model_connection", "bind_dataset_to_gateway", "takeover_item",
];

test("registry keeps every v1.5 tool name and adds the v2.0 batch", () => {
  const names = new Set(TOOLS.map((tool) => tool.name));
  for (const name of [...V1_5_TOOLS, ...NEW_IN_2_0]) assert.ok(names.has(name), `missing tool ${name}`);
  assert.equal(TOOLS.length, V1_5_TOOLS.length + NEW_IN_2_0.length);
  assert.equal(new Set(TOOLS.map((tool) => tool.name)).size, TOOLS.length, "tool names must be unique");
});

test("every tool is well-formed and its schema is a flat map of zod fields", () => {
  for (const tool of TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/);
    assert.ok(tool.description.length > 20, `${tool.name} description too short`);
    assert.ok(["read", "write"].includes(tool.mode));
    assert.equal(typeof tool.handler, "function");
    for (const [key, field] of Object.entries(tool.schema)) {
      assert.match(key, /^[a-z][a-z0-9_]*$/, `${tool.name}.${key} must be snake_case`);
      assert.equal(typeof field.safeParse, "function", `${tool.name}.${key} must be a zod schema`);
    }
    if (tool.mode === "write") assert.match(tool.description, /FABRIC_MCP_MODE=write/, `${tool.name} must say it needs write mode`);
  }
});

test("mode split matches the description gate and getTool accepts kebab-case", () => {
  assert.equal(READ_TOOLS.length + WRITE_TOOLS.length, TOOLS.length);
  assert.ok(WRITE_TOOLS.some((tool) => tool.name === "commit_to_git"));
  assert.ok(READ_TOOLS.some((tool) => tool.name === "get_item_connections"));
  assert.equal(getTool("list-item-runs")?.name, "list_item_runs");
  assert.equal(getTool("LIST_WORKSPACES")?.name, "list_workspaces");
  assert.equal(getTool("nope"), null);
  for (const tool of WRITE_TOOLS) assert.match(WRITE_MODE_MESSAGE, new RegExp(tool.name));
});

test("MCP registration honours the write gate and wraps handlers into content blocks", async () => {
  const registered = [];
  const fakeServer = { registerTool: (name, meta, handler) => registered.push({ name, meta, handler }) };
  registerTools(fakeServer, { writeEnabled: false });
  assert.equal(registered.length, READ_TOOLS.length);
  assert.ok(registered.every((entry) => typeof entry.meta.description === "string" && entry.meta.inputSchema));

  registered.length = 0;
  registerTools(fakeServer, { writeEnabled: true });
  assert.equal(registered.length, TOOLS.length);

  const okWrapped = wrapHandler({ handler: async ({ x }) => ({ doubled: x * 2 }) });
  assert.deepEqual(await okWrapped({ x: 2 }), { content: [{ type: "text", text: JSON.stringify({ doubled: 4 }, null, 2) }] });
  const errWrapped = wrapHandler({ handler: async () => { throw new Error("boom"); } });
  assert.deepEqual(await errWrapped({}), { content: [{ type: "text", text: "boom" }], isError: true });
});

test("run_notebook no longer tells the caller that re-invoking with wait=true polls", () => {
  assert.doesNotMatch(DETACHED_NOTE, /call again with wait=true/i);
  assert.match(DETACHED_NOTE, /job_instance_id/);
  assert.match(DETACHED_NOTE, /SECOND run/);
  const schema = getTool("run_notebook").schema;
  assert.ok(schema.job_instance_id, "run_notebook must accept job_instance_id to attach to an existing run");
});
