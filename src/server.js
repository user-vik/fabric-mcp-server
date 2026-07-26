import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeCredential } from "./auth/credentials.js";
import { VERSION, WRITE_ENABLED } from "./config.js";
import { registerReadTools } from "./mcp/read-tools.js";
import { WRITE_MODE_MESSAGE, registerWriteTools } from "./mcp/write-tools.js";

const server = new McpServer({ name: "fabric-mcp", version: VERSION });

registerReadTools(server);
if (WRITE_ENABLED) {
  console.error(WRITE_MODE_MESSAGE);
  registerWriteTools(server);
}

async function startServer() {
  initializeCredential();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[fabric-mcp] v${VERSION} ready (mode=${WRITE_ENABLED ? "write" : "read"})`);
}

export { server, startServer };
