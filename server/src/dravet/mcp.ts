import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AppError } from "../server/store.js";
import type { DravetStore } from "./store.js";
import { windowInput } from "./contracts.js";

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export function createDravetMcp(store: DravetStore, token: string) {
  store.authenticate(token, "agent");
  const server = new McpServer({ name: "dravet-monitor", version: "0.1.0" }, { instructions: "先get_connection核对患者和授权，只查询当前患者的监测数据。明确时间窗和时区；measured、replay、synthetic分别呈现。缺失不等于正常，phone_received不等于设备验证时间，raw加速度不可解释为物理单位。不诊断、不修改医学规则、不控制设备、不发送警报；提醒请求、设备自报响铃和家长确认不是临床确认。不索要或复述凭据。" });
  async function execute(fn: (p: ReturnType<DravetStore["authenticate"]>) => unknown) {
    try {
      const p = store.authenticate(token, "agent"), value = fn(p) as Record<string, unknown>;
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
    } catch (e) {
      const error = e instanceof AppError ? { code: e.code, message: e.message } : e instanceof z.ZodError ? { code: "INVALID_INPUT", message: "请提供含时区且不超过七天的明确时间窗。" } : { code: "INTERNAL_ERROR", message: "监测查询失败，请检查服务。" };
      return { content: [{ type: "text" as const, text: JSON.stringify({ error }) }], structuredContent: { error }, isError: true };
    }
  }
  server.registerTool("get_connection", { description: "核对单患者监测只读授权，身份只由Bearer凭据决定。", inputSchema: z.object({}).strict(), annotations }, () => execute(() => store.connection(token)));
  server.registerTool("list_devices", { description: "读取当前患者设备登记与撤销状态；不是在线状态。", inputSchema: z.object({}).strict(), annotations }, () => execute(p => ({ devices: store.devices(p.user, p.patientId) })));
  for (const kind of ["samples", "events"] as const) server.registerTool("get_" + kind, { description: `按明确时间窗读取${kind === "samples" ? "采样" : "事件"}，注意truncated和来源标记。`, inputSchema: windowInput, annotations }, input => execute(p => store.read(p.user, p.patientId, kind, input)));
  server.registerTool("get_night_summary", { description: "取得时间窗内记录计数、质量与会话内最大间隔，不计算临床风险或连续覆盖率。", inputSchema: windowInput, annotations }, input => execute(p => store.summary(p.user, p.patientId, input)));
  return server;
}
export async function handleDravetMcp(req: IncomingMessage, res: ServerResponse, store: DravetStore) {
  const token = /^Bearer (da_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  store.authenticate(token, "agent");
  if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
  const server = createDravetMcp(store, token), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 512 * 1024 });
  res.once("close", () => { void server.close().catch(() => process.stderr.write("DRAVET_MCP_CLOSE_ERROR\n")); });
  await server.connect(transport); await transport.handleRequest(req, res);
}
