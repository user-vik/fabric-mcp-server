import deployment from "./deployment.js";
import git from "./git.js";
import items from "./items.js";
import jobs from "./jobs.js";
import onelake from "./onelake.js";
import semanticModels from "./semantic-models.js";
import workspaces from "./workspaces.js";

const TOOLS = Object.freeze([...workspaces, ...jobs, ...semanticModels, ...git, ...items, ...deployment, ...onelake]);

const byName = new Map();
for (const tool of TOOLS) {
  if (byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
  byName.set(tool.name, tool);
}

const READ_TOOLS = Object.freeze(TOOLS.filter((tool) => tool.mode === "read"));
const WRITE_TOOLS = Object.freeze(TOOLS.filter((tool) => tool.mode === "write"));

function getTool(name) {
  return byName.get(String(name ?? "").replace(/-/g, "_").toLowerCase()) ?? null;
}

export { READ_TOOLS, TOOLS, WRITE_TOOLS, getTool };
