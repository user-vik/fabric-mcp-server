import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeCredential } from "./auth/credentials.js";
import { VERSION, WRITE_ENABLED } from "./config.js";
import { WRITE_MODE_MESSAGE, registerTools } from "./mcp/register.js";

const server = new McpServer({ name: "fabric-mcp", version: VERSION });

registerTools(server, { writeEnabled: WRITE_ENABLED });
if (WRITE_ENABLED) console.error(WRITE_MODE_MESSAGE);

async function startServer() {
  await initializeCredential();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[fabric-mcp] v${VERSION} ready (mode=${WRITE_ENABLED ? "write" : "read"})`);
}

export { server, startServer };
