import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { createDecipheriv, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { User } from "../shared/types.js";
import { inputSchemas, type ScaleId } from "../internal-assessments/contracts.js";
import { scoreAssessment } from "../internal-assessments/scoring.js";
import { AppError, FamilyStore } from "./store.js";
import { childInputSchema, recordInputSchema, registerSchema, loginSchema } from "./validation.js";
import { handleFamilyMcp } from "./mcp.js";
import { medicalSummary, summaryMarkdown } from "./medical.js";
import { savePrivateAttachment } from "./files.js";
import { DravetStore } from "../dravet/store.js";
import { handleDeviceHttp, handleParentHttp } from "../dravet/http.js";
import { handleDravetMcp } from "../dravet/mcp.js";
import { consoleHtml, consoleScript } from "../dravet/console.js";

const JSON_LIMIT = 512 * 1024, FILE_LIMIT = 8 * 1024 * 1024;
export type FamilyServerOptions = { dataDir: string; host?: string; port?: number; webRoot?: string; publicOrigin?: string; proxyToken?: string };
function json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
async function bytes(req: IncomingMessage, limit: number) {
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { const item = Buffer.from(chunk); length += item.length; if (length > limit) throw new AppError(413, "BODY_TOO_LARGE", "请求内容超过限制。"); chunks.push(item); }
  return Buffer.concat(chunks);
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new AppError(415, "CONTENT_TYPE", "请使用 application/json。");
  try { const parsed: unknown = JSON.parse((await bytes(req, JSON_LIMIT)).toString("utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return parsed as Record<string, unknown>; }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, "INVALID_JSON", "请求 JSON 无效。"); }
}
function cookie(req: IncomingMessage) { return req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith("family_session="))?.slice(15) ?? ""; }
function version(input: Record<string, unknown>) { return z.number().int().positive().parse(input.expectedVersion); }
function safeEqual(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

export async function startFamilyServer(options: FamilyServerOptions) {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") throw new Error("家长病程本首版只允许本地回环地址。");
  let publicOrigin: URL | undefined;
  if (options.publicOrigin || options.proxyToken) {
    publicOrigin = new URL(options.publicOrigin ?? "");
    if (publicOrigin.protocol !== "https:" || publicOrigin.origin !== options.publicOrigin || publicOrigin.username || publicOrigin.password || !options.proxyToken || !/^[a-zA-Z0-9_-]{32,128}$/.test(options.proxyToken)) throw new Error("公网配置需要规范 HTTPS origin 和至少 32 位代理密钥。");
  }
  const webRoot = options.webRoot === undefined ? undefined : resolve(options.webRoot);
  if (webRoot !== undefined) {
    const index = await stat(resolve(webRoot, "index.html"));
    if (!index.isFile()) throw new Error("FAMILY_WEB_ROOT 必须包含已构建的 index.html。");
  }
  const store = new FamilyStore(options.dataDir);
  let dravet: DravetStore;
  try { dravet = new DravetStore(store, resolve(options.dataDir, "dravet")); } catch (e) { store.close(); throw e; }
  const attachmentRoot = resolve(options.dataDir, "attachments"); await mkdir(attachmentRoot, { recursive: true });
  const authAttempts = new Map<string, { count: number; reset: number }>();
  let boundPort = options.port ?? 7870;
  const server = createServer(async (req, res) => {
    const requestId = randomUUID().slice(0, 8);
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY"); res.setHeader("X-Request-Id", requestId);
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
      const proxied = Boolean(publicOrigin && req.headers.host === publicOrigin.host);
      const proxyKey = req.headers["x-family-proxy-key"];
      const proxyIp = req.headers["x-family-client-ip"];
      if (proxied) {
        if (typeof proxyKey !== "string" || !safeEqual(proxyKey, options.proxyToken!) || typeof proxyIp !== "string" || !isIP(proxyIp)) throw new AppError(403, "INVALID_PROXY", "公网代理身份无效。");
      } else if (!allowedHosts.has(req.headers.host ?? "") || proxyKey !== undefined || proxyIp !== undefined) throw new AppError(403, "INVALID_HOST", "请求域名不在允许范围。");
      const requestOrigin = proxied ? publicOrigin!.origin : `http://${req.headers.host}`;
      const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${proxied ? "; Secure" : ""}`;
      const path = new URL(req.url ?? "/", "http://local").pathname;
      const isWrite = !["GET", "HEAD"].includes(req.method ?? "GET");
      const origins = proxied ? new Set([publicOrigin!.origin]) : new Set([...allowedHosts].map(h => `http://${h}`));
      if (!proxied) { origins.add("http://127.0.0.1:5174"); origins.add("http://localhost:5174"); }
      if (req.headers.origin && !origins.has(req.headers.origin)) throw new AppError(403, "INVALID_ORIGIN", "不允许此页面来源。");
      if (isWrite && req.headers["sec-fetch-site"] === "cross-site") throw new AppError(403, "INVALID_ORIGIN", "不允许跨站写入。");
      if (path === "/healthz" && req.method === "GET") return json(res, 200, { status: "ok", product: "family-timeline", storage: "sqlite", mode: publicOrigin ? "reverse-proxy" : "local-only" });
      if (path === "/api/family/setup" && req.method === "GET") return json(res, 200, { registrationOpen: !proxied && store.setup().registrationOpen });
      if ((path === "/api/family/register" || path === "/api/family/login") && req.method === "POST") {
        if (proxied && path.endsWith("register") && store.setup().registrationOpen) throw new AppError(403, "LOCAL_SETUP_REQUIRED", "请先由服务管理员在本机建立管理员账户，再使用邀请码注册。");
        const attemptKey = proxied ? proxyIp as string : req.socket.remoteAddress ?? "local"; const now = Date.now();
        for (const [key, attempt] of authAttempts) if (attempt.reset < now) authAttempts.delete(key);
        if (authAttempts.size >= 10000 && !authAttempts.has(attemptKey)) throw new AppError(429, "RATE_LIMITED", "登录请求过多，请稍后重试。");
        let attempt = authAttempts.get(attemptKey);
        if (!attempt || attempt.reset < now) { attempt = { count: 0, reset: now + 60000 }; authAttempts.set(attemptKey, attempt); }
        if (++attempt.count > 20) throw new AppError(429, "RATE_LIMITED", "登录尝试过多，请一分钟后重试。");
        const input = await body(req), result = path.endsWith("register") ? store.register(registerSchema.parse(input)) : store.login(loginSchema.parse(input));
        res.setHeader("Set-Cookie", `family_session=${result.token}; ${cookieFlags}; Max-Age=604800`);
        return json(res, path.endsWith("register") ? 201 : 200, { user: result.user, csrfToken: result.csrfToken });
      }
      const shared = path.match(/^\/api\/family\/shared\/([a-zA-Z0-9_-]+)$/);
      if (shared && req.method === "GET") return json(res, 200, store.sharedSummary(shared[1]!));
      if (path === "/mcp/family") return await handleFamilyMcp(req, res, store, options.dataDir, requestOrigin);
      if (path === "/mcp/dravet") return await handleDravetMcp(req, res, dravet);
      if (await handleDeviceHttp(req, res, path, dravet, { body, json })) return;
      if (["/dravet", "/dravet/", "/dravet/app.js"].includes(path)) {
        if (isWrite) throw new AppError(405, "METHOD_NOT_ALLOWED", "不支持此请求方法。");
        res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
        return res.end(req.method === "HEAD" ? undefined : path.endsWith(".js") ? consoleScript : webRoot ? consoleHtml : consoleHtml.replace('<nav><a href="/">病程本</a></nav>', '<nav>病程本 · 独立监测服务</nav>'));
      }
      if (!path.startsWith("/api/")) {
        if (isWrite) throw new AppError(405, "METHOD_NOT_ALLOWED", "不支持此请求方法。");
        if (webRoot === undefined) throw new AppError(404, "STATIC_WEB_DISABLED", "当前为独立 API 服务，未配置网页目录。");
        const isPage = !extname(path) || path.startsWith("/family/share/") || path.startsWith("/share/");
        const file = resolve(webRoot, isPage ? "index.html" : `.${decodeURIComponent(path)}`);
        if (!file.startsWith(`${webRoot}${sep}`)) throw new AppError(403, "INVALID_PATH", "路径无效。");
        let info; try { info = await stat(file); } catch { throw new AppError(404, "NOT_FOUND", "页面或文件不存在，请检查 FAMILY_WEB_ROOT 指向的前端构建目录。"); }
        if (!info.isFile()) throw new AppError(404, "NOT_FOUND", "页面不存在。");
        const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
        res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream"); return res.end(req.method === "HEAD" ? undefined : await readFile(file));
      }
      const token = cookie(req), session = store.authenticate(token);
      if (!session) throw new AppError(401, "UNAUTHORIZED", "请先登录。");
      const user: User = session.user;
      if (isWrite && !safeEqual(req.headers["x-csrf-token"]?.toString() ?? "", session.csrfToken)) throw new AppError(403, "CSRF", "页面会话已更新，请刷新后重试。");
      if (await handleParentHttp(req, res, dravet, user, publicOrigin?.origin ?? requestOrigin, { body, json })) return;
      if (path === "/api/family/session" && req.method === "GET") return json(res, 200, session);
      if (path === "/api/family/connection-info" && req.method === "GET") return json(res, 200, { endpoint: (publicOrigin?.origin ?? requestOrigin) + "/mcp/family" });
      if (path === "/api/family/logout" && req.method === "POST") { store.logout(token); res.setHeader("Set-Cookie", `family_session=; ${cookieFlags}; Max-Age=0`); return json(res, 200, { ok: true }); }
      if (path === "/api/family/invites" && req.method === "POST") return json(res, 201, store.createInvite(user));
      if (path === "/api/family/audit" && req.method === "GET") return json(res, 200, { entries: store.audit(user) });
      if (path === "/api/family/agent-grants" && req.method === "GET") return json(res, 200, { grants: store.listFamilyAgentGrants(user) });
      if (path === "/api/family/agent-grants" && req.method === "POST") return json(res, 201, { grant: store.createFamilyAgentGrant(user, await body(req)) });
      const familyGrant = path.match(/^\/api\/family\/agent-grants\/([^/]+)$/);
      if (familyGrant && req.method === "DELETE") { store.revokeFamilyAgentGrant(user, familyGrant[1]!); return json(res, 200, { ok: true }); }
      if (path === "/api/family/children") {
        if (req.method === "GET") return json(res, 200, { children: store.listChildren(user) });
        if (req.method === "POST") return json(res, 201, { child: store.createChild(user, childInputSchema.parse(await body(req))) });
      }
      const match = path.match(/^\/api\/family\/children\/([^/]+)(?:\/(.*))?$/);
      if (!match) throw new AppError(404, "NOT_FOUND", "接口不存在。");
      const childId = match[1]!, route = match[2] ?? ""; store.assertChild(user, childId);
      if (!route && req.method === "PATCH") { const input = await body(req); return json(res, 200, { child: store.updateChild(user, childId, childInputSchema.parse(input), version(input)) }); }
      if (route === "profile-revisions" && req.method === "GET") return json(res, 200, { revisions: store.profileRevisions(user, childId) });
      if (!route && req.method === "DELETE") { const input = await body(req); store.deleteChild(user, childId, z.string().parse(input.confirmation)); return json(res, 200, { ok: true }); }
      if (route === "agent-grants" && req.method === "GET") return json(res, 200, { grants: store.listAgentGrants(user, childId) });
      if (route === "agent-grants" && req.method === "POST") return json(res, 201, { grant: store.createAgentGrant(user, childId, await body(req)) });
      const grantMatch = route.match(/^agent-grants\/([^/]+)$/);
      if (grantMatch && req.method === "DELETE") { store.revokeAgentGrant(user, childId, grantMatch[1]!); return json(res, 200, { ok: true }); }
      if (route === "medical-summary" && req.method === "GET") { const summary = medicalSummary(store.assertChild(user, childId), store.listRecords(user, childId)); return json(res, 200, { summary, markdown: summaryMarkdown(summary) }); }
      if (route === "records" && req.method === "GET") return json(res, 200, { records: store.listRecords(user, childId) });
      if (route === "records" && req.method === "POST") return json(res, 201, { record: store.createRecord(user, childId, recordInputSchema.parse(await body(req)), req.headers["idempotency-key"]?.toString() ?? "") });
      const record = route.match(/^records\/([^/]+)(?:\/(confirm|revisions))?$/);
      if (record) {
        const recordId = record[1]!, action = record[2];
        if (action === "revisions" && req.method === "GET") return json(res, 200, { revisions: store.revisions(user, childId, recordId) });
        const input = await body(req);
        if (!action && req.method === "PUT") return json(res, 200, { record: store.updateRecord(user, childId, recordId, recordInputSchema.parse(Object.fromEntries(Object.entries(input).filter(([key]) => !["expectedVersion", "reason"].includes(key)))), version(input), z.string().trim().min(1).max(300).parse(input.reason)) });
        if (action === "confirm" && req.method === "POST") { z.literal(true).parse(input.attestation); return json(res, 200, { record: store.confirmRecord(user, childId, recordId, version(input)) }); }
        if (!action && req.method === "DELETE") { store.deleteRecord(user, childId, recordId, version(input)); return json(res, 200, { ok: true }); }
      }
      if (route === "attachments" && req.method === "GET") return json(res, 200, { attachments: store.listAttachments(user, childId) });
      if (route === "attachments" && req.method === "POST") {
        const mime = req.headers["content-type"]?.split(";")[0] ?? "", filename = basename(decodeURIComponent(req.headers["x-filename"]?.toString() ?? ""));
        const raw = await bytes(req, FILE_LIMIT);
        return json(res, 201, { attachment: await savePrivateAttachment(store, options.dataDir, user, childId, filename, mime, raw) });
      }
      const attachment = route.match(/^attachments\/([^/]+)$/);
      if (attachment && req.method === "GET") {
        const file = store.getAttachment(user, childId, attachment[1]!), encrypted = await readFile(file.storagePath), key = await readFile(resolve(options.dataDir, "key.bin"));
        const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
        decipher.setAAD(Buffer.from(`attachment:${childId}:${file.id}`));
        decipher.setAuthTag(encrypted.subarray(-16)); const raw = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
        res.setHeader("Content-Type", file.mime); res.setHeader("Content-Disposition", `attachment; filename="document${extname(file.filename).replace(/[^.a-zA-Z0-9]/g, "")}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`); return res.end(raw);
      }
      if (attachment && req.method === "DELETE") {
        // Authorize and check historical references before touching the original file.
        const file = store.deleteAttachment(user, childId, attachment[1]!);
        try { await unlink(file.storagePath); }
        catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
            throw new AppError(500, "FILE_CLEANUP_REQUIRED", `附件已从列表移除，但本地文件清理失败。请保留请求编号 ${requestId}，由管理员检查资料目录。`);
          }
        }
        return json(res, 200, { ok: true });
      }
      if (route === "export" && req.method === "GET") return json(res, 200, store.exportChild(user, childId));
      if (route === "shares" && req.method === "GET") return json(res, 200, { shares: store.listShares(user, childId) });
      if (route === "shares" && req.method === "POST") { const input = await body(req); const hours = z.union([z.literal(24), z.literal(72), z.literal(168)]).parse(input.hours), share = store.createShare(user, childId, hours); const { token: shareToken, ...publicShare } = share; return json(res, 201, { share: { ...publicShare, url: `${requestOrigin}/share/${shareToken}` } }); }
      const share = route.match(/^shares\/([^/]+)$/); if (share && req.method === "DELETE") { store.revokeShare(user, childId, share[1]!); return json(res, 200, { ok: true }); }
      if (route === "assessments" && req.method === "GET") return json(res, 200, { assessments: store.listAssessments(user, childId) });
      if (route === "assessments" && req.method === "POST") {
        if (user.role !== "admin") throw new AppError(403, "ADMIN_ONLY", "内部验证仅限本地管理员。");
        const input = z.object({ scaleId: z.enum(["mas_2016", "ms_2019", "hlh_2004"]), assessmentDate: z.string(), recordIds: z.array(z.string()).min(1).max(30), context: z.record(z.unknown()), clinical: z.record(z.unknown()).optional() }).strict().parse(await body(req));
        const records = store.getSelectedRecords(user, childId, input.recordIds, input.assessmentDate), labs: Record<string, unknown> = {};
        const schema = inputSchemas[input.scaleId as ScaleId], allowedLabs = Object.keys(schema.shape.labs.shape);
        for (const record of records) for (const item of record.measurements) if (allowedLabs.includes(item.code)) { if (labs[item.code]) throw new AppError(409, "DUPLICATE_METRIC", "所选记录存在同名指标，请只选一个采样结果。"); labs[item.code] = { value: item.value, unit: item.unit, collectedAt: record.occurredOn, source: record.source, confirmation: "confirmed" }; }
        const payload = { context: { ...input.context, assessmentDate: input.assessmentDate }, ...(input.scaleId !== "mas_2016" ? { clinical: input.clinical ?? {} } : {}), labs };
        const result = scoreAssessment(input.scaleId, schema.parse(payload));
        return json(res, 201, { assessment: store.saveAssessment(user, childId, { scaleId: input.scaleId, assessmentDate: input.assessmentDate, inputVersions: records.map(r => ({ id: r.id, version: r.version })), result }) });
      }
      throw new AppError(404, "NOT_FOUND", "接口或方法不存在。");
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof AppError) { if (error.status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="family-medical-records"'); return json(res, error.status, { error: { code: error.code, message: error.message } }); }
      if (error instanceof z.ZodError) return json(res, 400, { error: { code: "INVALID_INPUT", message: error.issues.slice(0, 6).map(i => `${i.path.join(".")}: ${i.message}`).join("；") } });
      process.stderr.write(`[family ${requestId}] ${error instanceof Error ? error.name : "UnknownError"}\n`);
      return json(res, 500, { error: { code: "INTERNAL_ERROR", message: `服务处理失败，请重试。请求编号 ${requestId}` } });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(boundPort, host, () => { server.off("error", reject); done(); }); });
  const address = server.address(); if (address && typeof address !== "string") boundPort = address.port;
  let closed = false;
  return { url: `http://${host === "::1" ? "[::1]" : host}:${boundPort}`, server, store, dravet, close: async () => { if (closed) return; closed = true; server.closeIdleConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); dravet.close(); store.close(); } };
}
