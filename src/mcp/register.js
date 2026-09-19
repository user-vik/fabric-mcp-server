import { READ_TOOLS, WRITE_TOOLS } from "../tools/index.js";

function toContent(result) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function wrapHandler(tool) {
  return async (args) => {
    try {
      return toContent(await tool.handler(args ?? {}));
    } catch (error) {
      return { content: [{ type: "text", text: error?.message ?? String(error) }], isError: true };
    }
  };
}

function registerTools(server, { writeEnabled }) {
  const tools = writeEnabled ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, wrapHandler(tool));
  }
  return tools;
}

const WRITE_MODE_MESSAGE = `[fabric-mcp] write mode enabled — ${WRITE_TOOLS.map((tool) => tool.name).join(", ")} exposed`;

export { WRITE_MODE_MESSAGE, registerTools, toContent, wrapHandler };
