import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir } from "node:fs/promises";
import { FamilyStore } from "./store.js";
import { createFamilyMcp } from "./mcp.js";

const dataDir = resolve(process.env.FAMILY_DATA_DIR ?? "family-data");
const token = process.env.FAMILY_AGENT_TOKEN ?? "";
if (!token) throw new Error("请通过 FAMILY_AGENT_TOKEN 提供在网页中生成的专用连接凭据。");
const store = new FamilyStore(dataDir);
try {
  store.authenticateAgent(token);
  await mkdir(resolve(dataDir, "attachments"), { recursive: true });
  const server = createFamilyMcp(store, token, dataDir, process.env.FAMILY_PUBLIC_ORIGIN);
  server.server.onclose = () => { store.close(); };
  await server.connect(new StdioServerTransport());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    void server.close().catch(() => { process.stderr.write("FAMILY_MCP_CLOSE_ERROR\n"); process.exitCode = 1; });
  });
} catch (error) { store.close(); throw error; }
