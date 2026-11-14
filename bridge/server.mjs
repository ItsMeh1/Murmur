import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMurmurTools } from "./tools.mjs";

const server = new McpServer({ name: "murmur-bridge", version: "1.0.0" });
let client = null;
registerMurmurTools(server, {
  getClient: () => client,
  setClient: (nextClient) => { client = nextClient; },
});

const transport = new StdioServerTransport();
await server.connect(transport);
