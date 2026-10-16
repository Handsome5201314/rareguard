import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFamilyServer } from "../src/server/http.js";
import { FamilyStore } from "../src/server/store.js";
import { savePrivateAttachment } from "../src/server/files.js";
import type { RecordInput, AgentScope } from "../src/shared/types.js";

// All records and file bytes in this suite are constructed test data.
const input = (overrides: Partial<RecordInput> = {}): RecordInput => ({
  kind: "lab", occurredOn: "2026-10-14", occurredTime: "10:20:30", timezone: "Asia/Shanghai",
  title: "合成检验", notes: "合成资料", source: "合成检验单", measurements: [{ code: "ferritin", value: ">751.123456789012", unit: "ng/mL" }], attachmentIds: [], ...overrides,
});
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zx7cAAAAASUVORK5CYII=";
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "family-agent-test-"));
  const app = await startFamilyServer({ dataDir: dir, port: 0 });
  const sessions = [app.store.register({ username: "synthetic_admin", displayName: "测试管理", password: "synthetic-long-password-2026", consent: true })];
  const invitation = app.store.createInvite(sessions[0]!.user);
  sessions.push(app.store.register({ username: "synthetic_parent", displayName: "测试家长", password: "synthetic-long-password-2026", consent: true, inviteCode: invitation.code }));
  const a = sessions[0]!, b = sessions[1]!;
  const ca = app.store.createChild(a.user, { nickname: "合成孩子A", birthYear: null, diagnosis: "", validationConsent: false });
  const cb = app.store.createChild(b.user, { nickname: "合成孩子B", birthYear: null, diagnosis: "", validationConsent: false });
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const grant = (scopes: AgentScope[] = ["records:read", "drafts:write", "attachments:write"]) => app.store.createAgentGrant(a.user, ca.id, { name: "合成Octop连接", scopes, days: 7, consent: true });
  const connect = async (token: string) => {
    const client = new Client({ name: "synthetic-octop-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + "/mcp/family"), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { failed: result.isError === true, data: result.structuredContent as Record<string, any>, result };
  };
  const api = async (method: string, path: string, data?: unknown, session = a) => fetch(app.url + "/api/family" + path, {
    method, headers: { Cookie: "family_session=" + session.token, Origin: app.url, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { app, dir, a, b, ca, cb, grant, connect, call, api };
}

test("MCP discovery exposes nine bounded tools and no confirm/delete/share/clinical scoring tool", async t => {
  const f = await fixture(t), client = await f.connect(f.grant().token);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 9);
  assert.ok(tools.tools.some(tool => tool.name === "create_record_draft"));
  assert.ok(tools.tools.every(tool => !/confirm|delete|share|score/.test(tool.name)));
  const connection = await f.call(client, "get_connection");
  assert.equal(connection.data.child.id, f.ca.id);
});

test("MCP requires Bearer, rejects cookies alone, bad Origin/Host, and exposes no browser API to agent tokens", async t => {
  const f = await fixture(t), token = f.grant().token;
  assert.equal((await fetch(f.app.url + "/mcp/family", { headers: { Cookie: "family_session=" + f.a.token } })).status, 401);
  assert.equal((await fetch(f.app.url + "/mcp/family", { headers: { Authorization: "Bearer " + token } })).status, 405);
  assert.equal((await fetch(f.app.url + "/mcp/family", { method: "POST", headers: { Authorization: "Bearer " + token, Origin: "https://foreign.invalid" } })).status, 403);
  const hostStatus = await new Promise<number>(resolve => { const req = httpRequest(f.app.url + "/mcp/family", { headers: { Host: "foreign.invalid", Authorization: "Bearer " + token } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(f.app.url + "/api/family/children", { headers: { Authorization: "Bearer " + token } })).status, 401);
});

test("grant HTTP requires consent, scopes, owned child and CSRF; raw tokens are returned only on creation", async t => {
  const f = await fixture(t), path = "/children/" + f.ca.id + "/agent-grants";
  assert.equal((await f.api("POST", path, { name: "test", scopes: ["records:read"], days: 7, consent: false })).status, 400);
  assert.equal((await f.api("POST", "/children/" + f.cb.id + "/agent-grants", { name: "test", scopes: ["records:read"], days: 7, consent: true })).status, 404);
  const response = await f.api("POST", path, { name: "test", scopes: ["records:read"], days: 7, consent: true });
  assert.equal(response.status, 201);
  const { grant } = await response.json();
  assert.match(grant.token, /^family_/);
  const listing = await (await f.api("GET", path)).json();
  assert.equal("token" in listing.grants[0], false);
  assert.equal((await fetch(f.app.url + "/api/family" + path, { method: "POST", headers: { Cookie: "family_session=" + f.a.token, "Content-Type": "application/json" }, body: "{}" })).status, 403);
  const raw = await readFile(join(f.dir, "family.sqlite-wal"));
  assert.equal(raw.includes(Buffer.from(grant.token)), false);
});

test("read-only and write-only grants enforce per-tool scopes", async t => {
  const f = await fixture(t), read = await f.connect(f.grant(["records:read"]).token), write = await f.connect(f.grant(["drafts:write"]).token);
  assert.equal((await f.call(read, "create_record_draft", { messageId: "one", channel: "api", sourceText: "", record: input() })).data.error.code, "AGENT_SCOPE");
  assert.equal((await f.call(write, "list_records")).data.error.code, "AGENT_SCOPE");
  assert.equal((await f.call(write, "upload_attachment", { filename: "test.png", mime: "image/png", base64: png })).data.error.code, "AGENT_SCOPE");
});

test("strict tools reject child/owner spoofing and model confirmation; cross-family records stay invisible", async t => {
  const f = await fixture(t), client = await f.connect(f.grant().token);
  f.app.store.createRecord(f.b.user, f.cb.id, input({ title: "其他家庭记录" }), "other");
  assert.equal((await f.call(client, "list_records")).data.records.length, 0);
  assert.equal((await f.call(client, "list_records", { childId: f.cb.id })).failed, true);
  assert.equal((await f.call(client, "create_record_draft", { messageId: "spoof", channel: "api", sourceText: "", record: { ...input(), confirmation: "user_confirmed", ownerId: f.b.user.id } })).failed, true);
  assert.equal(f.app.store.listRecords(f.a.user, f.ca.id).length, 0);
});

test("stable message IDs deduplicate exact payloads, preserve precision and reject changed payload retries", async t => {
  const f = await fixture(t), client = await f.connect(f.grant().token);
  const args = { messageId: "event-001", channel: "feishu", sourceText: "合成报告，不能视为真实资料", record: input() };
  const first = await f.call(client, "create_record_draft", args), second = await f.call(client, "create_record_draft", args);
  assert.equal(first.failed, false); assert.equal(first.data.record.id, second.data.record.id);
  assert.equal(first.data.record.confirmation, "draft");
  assert.equal(first.data.record.measurements[0].value, ">751.123456789012");
  assert.equal(first.data.record.intake.channel, "feishu");
  assert.equal(f.app.store.listRecords(f.a.user, f.ca.id).length, 1);
  assert.equal((await f.call(client, "create_record_draft", { ...args, record: input({ title: "改动的同一次投递" }) })).data.error.code, "IDEMPOTENCY_CONFLICT");
});

test("validation asks for missing fields and rejects invalid dates, unsupported units and unknown clinical sections", async t => {
  const f = await fixture(t), client = await f.connect(f.grant().token);
  const missing = await f.call(client, "validate_record_draft", { record: { kind: "lab" } });
  assert.equal(missing.data.valid, false); assert.ok(missing.data.issues.some((issue: any) => issue.path === "occurredOn"));
  for (const record of [input({ occurredOn: "2026-02-30" }), input({ measurements: [{ code: "ferritin", value: "12", unit: "made-up" }] }), { ...input(), clinical: { guessedDiagnosis: "made-up" } }]) {
    const result = await f.call(client, "create_record_draft", { messageId: "invalid", channel: "api", sourceText: "", record });
    assert.equal(result.failed, true);
  }
  assert.equal(f.app.store.listRecords(f.a.user, f.ca.id).length, 0);
});

test("agent can revise only its own draft with exact version, never confirmed or manual records", async t => {
  const f = await fixture(t), g = f.grant(), client = await f.connect(g.token);
  const created = (await f.call(client, "create_record_draft", { messageId: "edit", channel: "api", sourceText: "", record: input() })).data.record;
  const edit = { recordId: created.id, expectedVersion: 1, reason: "核对合成资料", record: input({ notes: "补充原文" }) };
  const updated = await f.call(client, "update_record_draft", edit);
  assert.equal(updated.data.record.version, 2); assert.equal(updated.data.record.intake.messageId, "edit");
  assert.equal((await f.call(client, "update_record_draft", edit)).data.error.code, "VERSION_CONFLICT");
  const other = await f.connect(f.grant().token);
  assert.equal((await f.call(other, "update_record_draft", { ...edit, expectedVersion: 2 })).data.error.code, "AGENT_DRAFT_ONLY");
  f.app.store.confirmRecord(f.a.user, f.ca.id, created.id, 2);
  assert.equal((await f.call(client, "update_record_draft", { ...edit, expectedVersion: 2 })).data.error.code, "AGENT_DRAFT_ONLY");
  const manual = f.app.store.createRecord(f.a.user, f.ca.id, input(), "manual");
  assert.equal((await f.call(client, "update_record_draft", { ...edit, recordId: manual.id })).data.error.code, "AGENT_DRAFT_ONLY");
});

test("medical summary uses only confirmed sections with source/version and no invented missing history", async t => {
  const f = await fixture(t), client = await f.connect(f.grant().token);
  const record = f.app.store.createRecord(f.a.user, f.ca.id, input({ clinical: { chiefComplaint: "合成主诉", presentIllness: "合成现病史" } }), "medical");
  f.app.store.createRecord(f.a.user, f.ca.id, input({ clinical: { pastHistory: "尚未核对的既往史" } }), "unconfirmed");
  f.app.store.confirmRecord(f.a.user, f.ca.id, record.id, 1);
  const result = await f.call(client, "get_medical_summary");
  assert.equal(result.data.summary.excludedDrafts, 1);
  assert.equal(result.data.summary.sections[0].entries[0].recordId, record.id);
  assert.ok(result.data.markdown.includes("合成主诉"));
  assert.equal(result.data.markdown.includes("尚未核对的既往史"), false);
  assert.ok(result.data.markdown.includes("未记录"));
  const http = await (await f.api("GET", "/children/" + f.ca.id + "/medical-summary")).json();
  assert.equal(http.summary.timeline.length, 1);
});

test("agent uploads private signed files and links them; URLs, traversal and malformed base64 are rejected", async t => {
  const f = await fixture(t), client = await f.connect(f.grant().token);
  const uploaded = await f.call(client, "upload_attachment", { filename: "合成.png", mime: "image/png", base64: png });
  assert.equal(uploaded.failed, false); assert.equal("storagePath" in uploaded.data.attachment, false);
  const id = uploaded.data.attachment.id;
  const record = await f.call(client, "create_record_draft", { messageId: "attachment", channel: "wecom", sourceText: "合成", record: input({ attachmentIds: [id] }) });
  assert.equal(record.failed, false); assert.deepEqual(record.data.record.attachmentIds, [id]);
  for (const args of [{ filename: "../x.png", mime: "image/png", base64: png }, { filename: "x.png", mime: "image/png", base64: "a@@@" }, { filename: "x.png", mime: "image/png", base64: png, url: "http://127.0.0.1/private" }]) assert.equal((await f.call(client, "upload_attachment", args)).failed, true);
});

test("revocation, expiry and deleted children invalidate initialized clients on every request", async t => {
  const f = await fixture(t), g = f.grant(), client = await f.connect(g.token);
  assert.equal((await f.call(client, "get_connection")).failed, false);
  f.app.store.revokeAgentGrant(f.a.user, f.ca.id, g.id);
  await assert.rejects(() => client.listTools(), /AGENT_UNAUTHORIZED/);
  assert.equal((await fetch(f.app.url + "/mcp/family", { headers: { Authorization: "Bearer " + g.token } })).status, 401);
  const expired = f.grant(), db = new DatabaseSync(join(f.dir, "family.sqlite"));
  db.prepare("UPDATE agent_grants SET expires_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", expired.id); db.close();
  assert.throws(() => f.app.store.authenticateAgent(expired.token), /过期/);
  const active = f.grant(); f.app.store.deleteChild(f.a.user, f.ca.id, f.ca.nickname);
  assert.throws(() => f.app.store.authenticateAgent(active.token), /找不到/);
});

test("v1 migration preserves encrypted records, credentials and original manual idempotency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "family-migrate-test-"));
  try {
    let store = new FamilyStore(dir);
    const user = store.register({ username: "migration_user", displayName: "合成迁移", password: "synthetic-migration-password", consent: true }).user;
    const child = store.createChild(user, { nickname: "合成迁移孩子", birthYear: null, diagnosis: "", validationConsent: false });
    const record = store.createRecord(user, child.id, input(), "old-key"); store.close();
    const db = new DatabaseSync(join(dir, "family.sqlite"));
    db.exec("DROP TABLE agent_grants; PRAGMA user_version=1;"); db.close();
    store = new FamilyStore(dir);
    assert.equal(store.createRecord(user, child.id, input(), "old-key").id, record.id);
    const grant = store.createAgentGrant(user, child.id, { name: "migrated", scopes: ["records:read"], days: 1, consent: true });
    assert.equal(store.authenticateAgent(grant.token).grant.childId, child.id); store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real stdio client discovers tools and persists a draft in the same scoped store", async t => {
  const f = await fixture(t), grant = f.grant(), client = new Client({ name: "synthetic-stdio-client", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/server/mcp-stdio.js", import.meta.url))],
      env: { FAMILY_DATA_DIR: f.dir, FAMILY_AGENT_TOKEN: grant.token }, stderr: "pipe" }));
    assert.equal((await client.listTools()).tools.length, 9);
    const response = await f.call(client, "create_record_draft", { messageId: "stdio-event", channel: "web", sourceText: "合成", record: input() });
    assert.equal(response.failed, false); assert.equal(f.app.store.listRecords(f.a.user, f.ca.id).length, 1);
  } finally { await client.close(); }
});

test("attachment commit rechecks revoked authorization and cleans uncommitted encrypted bytes", async t => {
  const f = await fixture(t), grant = f.grant();
  await assert.rejects(() => savePrivateAttachment(f.app.store, f.dir, f.a.user, f.ca.id, "合成.png", "image/png", Buffer.from(png, "base64"), () => {
    f.app.store.revokeAgentGrant(f.a.user, f.ca.id, grant.id);
    f.app.store.authenticateAgent(grant.token, "attachments:write");
  }), /撤销/);
  assert.equal(f.app.store.listAttachments(f.a.user, f.ca.id).length, 0);
  assert.equal((await readdir(join(f.dir, "attachments"))).length, 0);
});
