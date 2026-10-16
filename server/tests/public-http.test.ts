import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { startFamilyServer } from "../src/server/http.js";

const publicOrigin = "https://family.example.test", proxyToken = "constructed-proxy-test-key-32-characters";
const registration = { username: "constructed_admin", displayName: "构造管理员", password: "constructed-password-2026", consent: true as const };
function fetchWithHeaders(base: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const target = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: Number(target.port), path: target.pathname + target.search, method: init.method ?? "GET", headers: init.headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const headers = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    });
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

test("public configuration fails closed before creating a database", async () => {
  for (const config of [{ publicOrigin: "http://family.example.test", proxyToken }, { publicOrigin: publicOrigin + "/", proxyToken }, { publicOrigin }, { proxyToken }, { publicOrigin, proxyToken: "short" }]) {
    await assert.rejects(startFamilyServer({ dataDir: "unused-invalid-public-config", port: 0, ...config }));
  }
});

test("trusted HTTPS proxy preserves local bootstrap, invite isolation, secure sessions and canonical URLs", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "family-public-test-"));
  const app = await startFamilyServer({ dataDir, port: 0, publicOrigin, proxyToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const gateway = { Host: "family.example.test", "X-Family-Proxy-Key": proxyToken, "X-Family-Client-IP": "203.0.113.41" };
  async function request(path: string, payload?: unknown, headers: Record<string, string> = gateway) {
    return fetchWithHeaders(app.url, path, { method: payload === undefined ? "GET" : "POST", headers: { ...headers, ...(payload === undefined ? {} : { "Content-Type": "application/json", Origin: headers.Host ? publicOrigin : app.url }) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  }
  assert.equal((await request("/api/family/setup")).status, 200);
  assert.deepEqual(await (await request("/api/family/setup")).json(), { registrationOpen: false });
  assert.equal((await request("/api/family/register", registration)).status, 403);
  assert.deepEqual(app.store.setup(), { registrationOpen: true });
  assert.equal((await request("/healthz", undefined, { Host: "family.example.test" })).status, 403);
  assert.equal((await request("/healthz", undefined, { ...gateway, "X-Family-Proxy-Key": "forged" })).status, 403);
  assert.equal((await request("/healthz", undefined, { ...gateway, "X-Family-Client-IP": "203.0.113.1, 203.0.113.2" })).status, 403);
  assert.equal((await request("/healthz", undefined, { ...gateway, Host: new URL(app.url).host })).status, 403);
  assert.equal((await request("/healthz", undefined, { ...gateway, Host: "evil.test" })).status, 403);
  assert.equal((await fetchWithHeaders(app.url, "/healthz", { headers: { ...gateway, Origin: app.url } })).status, 403);
  assert.equal((await fetchWithHeaders(app.url, "/api/family/login", { method: "POST", headers: { ...gateway, Origin: publicOrigin, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await request("/mcp/family", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
  const local = await request("/api/family/register", registration, {});
  assert.equal(local.status, 201);
  assert.doesNotMatch(local.headers.get("set-cookie")!, /; Secure/);
  const login = await request("/api/family/login", { username: registration.username, password: registration.password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!;
  assert.match(cookie, /; Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const session = await login.json() as { csrfToken: string };
  const auth = { ...gateway, Cookie: cookie.split(";")[0]!, "X-CSRF-Token": session.csrfToken };
  assert.deepEqual(await (await request("/api/family/connection-info", undefined, { ...auth, "X-Forwarded-Host": "evil.test", "X-Forwarded-Proto": "http" })).json(), { endpoint: publicOrigin + "/mcp/family" });
  const child = await (await request("/api/family/children", { nickname: "构造档案", birthYear: null, diagnosis: "", validationConsent: false }, auth)).json() as { child: { id: string } };
  assert.ok(child.child.id);
  assert.equal((await request("/api/family/invites", {}, { ...auth, "X-CSRF-Token": "wrong" })).status, 403);
  const invitation = await (await request("/api/family/invites", {}, auth)).json() as { code: string };
  const parent = await request("/api/family/register", { ...registration, username: "constructed_parent", inviteCode: invitation.code });
  assert.equal(parent.status, 201);
  const parentSession = await parent.json() as { user: { role: string }; csrfToken: string };
  assert.equal(parentSession.user.role, "parent");
  const parentAuth = { ...gateway, Cookie: parent.headers.get("set-cookie")!.split(";")[0]! };
  assert.equal((await request(`/api/family/children/${child.child.id}/records`, undefined, parentAuth)).status, 404);
  assert.equal((await request("/api/family/register", { ...registration, username: "invite_replay", inviteCode: invitation.code })).status, 403);
  const sharing = await (await request(`/api/family/children/${child.child.id}/shares`, { hours: 24 }, auth)).json() as { share: { url: string } };
  assert.ok(sharing.share.url.startsWith(publicOrigin + "/share/"));
  const logout = await request("/api/family/logout", {}, auth);
  assert.equal(logout.status, 200); assert.match(logout.headers.get("set-cookie")!, /; Secure/);
  assert.equal((await request("/api/family/session", undefined, auth)).status, 401);
});

test("login limit uses only authenticated proxy client IP and ignores spoofed forwarded headers", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "family-public-rate-"));
  const app = await startFamilyServer({ dataDir, port: 0, publicOrigin, proxyToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app.store.register(registration);
  const login = (ip: string, spoofed: string) => fetchWithHeaders(app.url, "/api/family/login", { method: "POST", headers: { Host: "family.example.test", Origin: publicOrigin, "Content-Type": "application/json", "X-Family-Proxy-Key": proxyToken, "X-Family-Client-IP": ip, "X-Forwarded-For": spoofed }, body: JSON.stringify({ username: "missing", password: "incorrect-password" }) });
  for (let i = 0; i < 20; i++) assert.equal((await login("203.0.113.10", `198.51.100.${i}`)).status, 401);
  assert.equal((await login("203.0.113.10", "198.51.100.200")).status, 429);
  assert.equal((await login("203.0.113.11", "198.51.100.200")).status, 401);
});

test("authenticated MCP remains scoped and revocable through the public proxy", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "family-public-mcp-"));
  const app = await startFamilyServer({ dataDir, port: 0, publicOrigin, proxyToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = app.store.register(registration).user;
  const child = app.store.createChild(owner, { nickname: "合成公网MCP验收", birthYear: null, diagnosis: "", validationConsent: false });
  const grant = app.store.createAgentGrant(owner, child.id, { name: "合成代理连接", scopes: ["records:read", "drafts:write"], days: 1, consent: true });
  const headers = { Host: "family.example.test", "X-Family-Proxy-Key": proxyToken, "X-Family-Client-IP": "203.0.113.20", "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + grant.token };
  const rpc = (method: string, params: unknown = {}) => fetchWithHeaders(app.url, "/mcp/family", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  assert.equal((await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "constructed-public-client", version: "1" } })).status, 200);
  const tools = await (await rpc("tools/list")).json() as { result: { tools: { name: string }[] } };
  assert.equal(tools.result.tools.length, 9);
  assert.ok(tools.result.tools.every(tool => !/confirm|delete|share|score/.test(tool.name)));
  const connection = await (await rpc("tools/call", { name: "get_connection", arguments: {} })).json() as { result: { structuredContent: { child: { id: string } } } };
  assert.equal(connection.result.structuredContent.child.id, child.id);
  const draft = await (await rpc("tools/call", { name: "create_record_draft", arguments: { channel: "api", messageId: "constructed-public-message", sourceText: "合成记录", record: { kind: "symptom", occurredOn: "2026-10-14", occurredTime: null, timezone: "Asia/Shanghai", title: "合成症状", notes: "仅供接口测试", source: "合成录入", measurements: [], attachmentIds: [] } } })).json() as { result: { isError?: boolean } };
  assert.notEqual(draft.result.isError, true);
  assert.equal(app.store.listRecords(owner, child.id)[0]!.confirmation, "draft");
  assert.equal((await fetchWithHeaders(app.url, "/api/family/children", { headers })).status, 401);
  app.store.revokeAgentGrant(owner, child.id, grant.id);
  assert.equal((await rpc("tools/list")).status, 401);
});

test("local login advertises the canonical public plugin endpoint and public account tokens remain isolated", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "family-public-account-"));
  const app = await startFamilyServer({ dataDir, port: 0, publicOrigin, proxyToken });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const session = app.store.register(registration);
  const localInfo = await fetch(app.url + "/api/family/connection-info", { headers: { Cookie: "family_session=" + session.token } });
  assert.equal((await localInfo.json()).endpoint, publicOrigin + "/mcp/family");
  const grant = app.store.createFamilyAgentGrant(session.user, { name: "合成公网插件", scopes: ["profiles:read", "profiles:write"], days: 1, consent: true });
  const headers = { Host: "family.example.test", "X-Family-Proxy-Key": proxyToken, "X-Family-Client-IP": "203.0.113.21", "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + grant.token };
  const call = (name: string, args: Record<string, unknown> = {}) => fetchWithHeaders(app.url, "/mcp/family", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const connection = await (await call("get_connection")).json(); assert.equal(connection.result.structuredContent.account.id, session.user.id);
  const created = await (await call("create_profile", { messageId: "public-create", channel: "octop", sourceText: "合成用户本人建档", userConfirmed: true, profile: { nickname: "合成公网本人", relationship: "self", birthYear: null, diagnosis: "" } })).json();
  assert.notEqual(created.result.isError, true); assert.equal(app.store.listChildren(session.user).length, 1);
  assert.equal((await call("list_records", { patientId: created.result.structuredContent.profile.id })).status, 200);
  const denied = await (await call("list_records", { patientId: created.result.structuredContent.profile.id })).json(); assert.equal(denied.result.structuredContent.error.code, "AGENT_SCOPE");
  app.store.revokeFamilyAgentGrant(session.user, grant.id); assert.equal((await call("get_connection")).status, 401);
});
