import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFamilyServer } from "../src/server/http.js";
import { AppError, FamilyStore } from "../src/server/store.js";
import { agentScopes, type AgentScope, type RecordInput } from "../src/shared/types.js";
import { connectionPackage } from "../src/shared/connection-package.js";

// All identities, clinical text, attachments and credentials are synthetic and temporary.
const password = "synthetic-account-test-password";
const profile = { nickname: "合成本人", relationship: "self" as const, birthYear: null, diagnosis: "" };
const record: RecordInput = { kind: "lab", title: "合成检验", notes: "合成原文", occurredOn: "2026-10-14", occurredTime: null, timezone: "Asia/Shanghai", source: "合成检验报告", measurements: [{ code: "ferritin", value: ">800.123456789", unit: "ng/mL" }], attachmentIds: [] };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zx7cAAAAASUVORK5CYII=";
const instruction = (messageId: string) => ({ messageId, channel: "octop", sourceText: "合成用户明确指令", userConfirmed: true });
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "family-account-test-")), app = await startFamilyServer({ dataDir: dir, port: 0 });
  const a = app.store.register({ username: "synthetic_account", displayName: "合成账号", password, consent: true });
  const invite = app.store.createInvite(a.user), b = app.store.register({ username: "synthetic_other", displayName: "合成其他家庭", password, consent: true, inviteCode: invite.code });
  const other = app.store.createChild(b.user, { ...profile, nickname: "合成其他患者", validationConsent: false });
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const grant = (scopes: readonly AgentScope[] = agentScopes) => app.store.createFamilyAgentGrant(a.user, { name: "合成家庭连接", scopes, days: 7, consent: true });
  const connect = async (token: string) => { const client = new Client({ name: "synthetic-octop-account", version: "1.0.0" }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL(app.url + "/mcp/family"), { requestInit: { headers: { Authorization: "Bearer " + token } } })); return client; };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => { const result = await client.callTool({ name, arguments: args }); return { failed: result.isError === true, data: result.structuredContent as Record<string, any> }; };
  const api = async (method: string, path: string, data?: unknown, session = a) => fetch(app.url + "/api/family" + path, { method, headers: { Cookie: "family_session=" + session.token, Origin: app.url, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { app, dir, a, b, other, grant, connect, call, api };
}

test("web login issues a revocable account connection before any patient exists; package contains parameters and instructions", async t => {
  const f = await fixture(t);
  const login = await fetch(f.app.url + "/api/family/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: f.app.url }, body: JSON.stringify({ username: f.a.user.username, password }) });
  assert.equal(login.status, 200);
  assert.equal((await f.api("POST", "/agent-grants", { name: "合成", scopes: ["profiles:read"], days: 7, consent: false })).status, 400);
  const response = await f.api("POST", "/agent-grants", { name: "合成", scopes: ["profiles:read", "profiles:write"], days: 7, consent: true });
  assert.equal(response.status, 201); const { grant } = await response.json();
  assert.equal(grant.access, "family"); assert.equal(grant.childId, null);
  const info = await (await f.api("GET", "/connection-info")).json();
  const pack = connectionPackage(info.endpoint, grant);
  assert.ok(pack.includes(info.endpoint)); assert.ok(pack.includes("Bearer " + grant.token));
  assert.ok(pack.includes("list_profiles")); assert.ok(pack.includes("get_connection")); assert.ok(pack.includes("无需我的账号密码"));
  assert.equal(pack.includes(password), false);
  const listing = await (await f.api("GET", "/agent-grants")).json(); assert.equal("token" in listing.grants[0], false);
  assert.equal((await f.api("GET", "/agent-grants", undefined, f.b)).status, 200);
  assert.equal((await (await f.api("GET", "/agent-grants", undefined, f.b)).json()).grants.length, 0);
  assert.equal((await f.api("DELETE", "/agent-grants/" + grant.id, {}, f.b)).status, 404);
  assert.equal((await fetch(f.app.url + "/api/family/agent-grants", { method: "POST", headers: { Cookie: "family_session=" + f.a.token, "Content-Type": "application/json" }, body: "{}" })).status, 403);
  const raw = await readFile(join(f.dir, "family.sqlite-wal")); assert.equal(raw.includes(Buffer.from(grant.token)), false);
});

test("conversation creates self and child once; both immediately appear in the web account with encrypted provenance", async t => {
  const f = await fixture(t), client = await f.connect(f.grant().token);
  assert.equal((await f.call(client, "get_connection")).data.access, "family");
  assert.equal((await f.call(client, "list_profiles")).data.profiles.length, 0);
  const args = { ...instruction("create-self"), profile }, one = await f.call(client, "create_profile", args), again = await f.call(client, "create_profile", args);
  assert.equal(one.failed, false); assert.equal(one.data.profile.id, again.data.profile.id);
  assert.equal(one.data.profile.relationship, "self"); assert.equal(one.data.profile.validationConsent, false);
  const child = await f.call(client, "create_profile", { ...instruction("create-child"), profile: { ...profile, nickname: "合成孩子", relationship: "child" } });
  assert.equal(child.failed, false);
  const web = await (await f.api("GET", "/children")).json(); assert.equal(web.children.length, 2);
  assert.deepEqual(web.children.map((item: any) => item.relationship).sort(), ["child", "self"]);
  const history = await (await f.api("GET", "/children/" + one.data.profile.id + "/profile-revisions")).json();
  assert.equal(history.revisions[0].source, "agent"); assert.equal(history.revisions[0].intake.channel, "octop");
  assert.equal((await f.call(client, "create_profile", { ...args, profile: { ...profile, nickname: "更改重复投递" } })).data.error.code, "IDEMPOTENCY_CONFLICT");
  const raw = await readFile(join(f.dir, "family.sqlite-wal")); assert.equal(raw.includes(Buffer.from(profile.nickname)), false);
});

test("web and agent profile edits share versions; stale writes cannot overwrite and partial updates preserve fields", async t => {
  const f = await fixture(t), client = await f.connect(f.grant().token);
  const current = f.app.store.createChild(f.a.user, { ...profile, birthYear: 2000, diagnosis: "合成已有诊断", validationConsent: false });
  const changed = await f.call(client, "update_profile", { ...instruction("profile-edit"), patientId: current.id, expectedVersion: 1, reason: "改代称", patch: { nickname: "合成新代称" } });
  assert.equal(changed.failed, false); assert.equal(changed.data.profile.version, 2); assert.equal(changed.data.profile.birthYear, 2000); assert.equal(changed.data.profile.diagnosis, current.diagnosis);
  assert.equal((await f.api("PATCH", "/children/" + current.id, { ...current, expectedVersion: 1, diagnosis: "不应覆盖" })).status, 409);
  const web = await (await f.api("PATCH", "/children/" + current.id, { ...changed.data.profile, expectedVersion: 2, diagnosis: "合成网页更新" })).json(); assert.equal(web.child.version, 3);
  assert.equal((await f.call(client, "update_profile", { ...instruction("profile-stale"), patientId: current.id, expectedVersion: 2, reason: "旧版本", patch: { diagnosis: "不能覆盖" } })).data.error.code, "VERSION_CONFLICT");
  const history = await f.call(client, "get_profile_history", { patientId: current.id }); assert.equal(history.data.revisions.length, 3);
  assert.deepEqual(history.data.revisions.map((r: any) => r.source), ["web", "agent", "web"]);
});

test("explicit patient selection, account ownership, strict input and narrow scopes block cross-family maintenance", async t => {
  const f = await fixture(t), client = await f.connect(f.grant().token), readonly = await f.connect(f.grant(["profiles:read", "records:read"]).token);
  assert.equal((await f.call(client, "list_records")).data.error.code, "PATIENT_REQUIRED");
  for (const name of ["get_profile", "list_records", "get_medical_summary", "get_profile_history", "get_lab_trends"]) assert.equal((await f.call(client, name, { patientId: f.other.id })).data.error.code, "CHILD_NOT_FOUND");
  assert.equal((await f.call(client, "update_profile", { ...instruction("foreign"), patientId: f.other.id, expectedVersion: 1, reason: "越权", patch: { nickname: "不能改" } })).data.error.code, "CHILD_NOT_FOUND");
  assert.equal((await f.call(readonly, "create_profile", { ...instruction("read-only"), profile })).data.error.code, "AGENT_SCOPE");
  for (const extra of [{ ownerId: f.b.user.id }, { username: f.b.user.username }, { channelUserId: "someone" }]) assert.equal((await f.call(client, "create_profile", { ...instruction("spoof"), profile, ...extra })).failed, true);
  assert.equal((await f.call(client, "create_profile", { ...instruction("consent-spoof"), profile: { ...profile, validationConsent: true } })).failed, true);
  assert.equal(f.app.store.assertChild(f.b.user, f.other.id).nickname, f.other.nickname);
});

test("account maintenance edits web records, requires user attestation for confirmation and retains trace and history", async t => {
  const f = await fixture(t), grant = f.grant(), client = await f.connect(grant.token);
  const child = f.app.store.createChild(f.a.user, { ...profile, validationConsent: false }), original = f.app.store.createRecord(f.a.user, child.id, record, "manual");
  const args = { ...instruction("confirm-one"), patientId: child.id, recordId: original.id, expectedVersion: 1, attestation: true };
  assert.equal((await f.call(client, "confirm_record", { ...args, attestation: false })).failed, true);
  assert.equal((await f.call(client, "confirm_record", { ...args, userConfirmed: false })).failed, true);
  assert.equal(f.app.store.listRecords(f.a.user, child.id)[0]!.confirmation, "draft");
  const confirmed = await f.call(client, "confirm_record", args); assert.equal(confirmed.data.record.confirmation, "user_confirmed");
  assert.equal(confirmed.data.record.confirmationIntake.grantId, grant.id);
  assert.equal((await f.call(client, "confirm_record", args)).failed, false);
  const updated = await f.call(client, "update_record", { ...instruction("record-edit"), patientId: child.id, recordId: original.id, expectedVersion: 1, reason: "更正说明", record: { ...record, notes: "合成更正" } });
  assert.equal(updated.data.record.version, 2); assert.equal(updated.data.record.confirmation, "draft"); assert.equal(updated.data.record.confirmationIntake, undefined);
  assert.equal((await f.call(client, "get_lab_trends", { patientId: child.id })).data.points.length, 0);
  await f.call(client, "confirm_record", { ...args, ...instruction("confirm-two"), expectedVersion: 2 });
  const trend = await f.call(client, "get_lab_trends", { patientId: child.id }); assert.equal(trend.data.points[0].value, ">800.123456789");
  const history = await f.call(client, "get_record_history", { patientId: child.id, recordId: original.id }); assert.equal(history.data.revisions.length, 4);
  assert.equal((await f.call(client, "delete_record", { ...instruction("delete-record"), patientId: child.id, recordId: original.id, expectedVersion: 1 })).data.error.code, "VERSION_CONFLICT");
  assert.equal((await f.call(client, "delete_record", { ...instruction("delete-record-current"), patientId: child.id, recordId: original.id, expectedVersion: 2 })).failed, false);
  assert.equal((await (await f.api("GET", "/children/" + child.id + "/records")).json()).records.length, 0);
  assert.equal((await f.call(client, "get_record_history", { patientId: child.id, recordId: original.id })).data.revisions.length, 5);
});

test("account connection manages encrypted originals without leaking paths or deleting historically referenced files", async t => {
  const f = await fixture(t), client = await f.connect(f.grant().token), child = f.app.store.createChild(f.a.user, { ...profile, validationConsent: false });
  const uploaded = await f.call(client, "upload_attachment", { patientId: child.id, filename: "合成.png", mime: "image/png", base64: png }); assert.equal(uploaded.failed, false);
  const attachmentId = uploaded.data.attachment.id;
  const downloaded = await f.call(client, "download_attachment", { patientId: child.id, attachmentId }); assert.equal(downloaded.data.base64, png); assert.equal("storagePath" in downloaded.data, false);
  assert.equal((await f.call(client, "download_attachment", { patientId: f.other.id, attachmentId })).data.error.code, "CHILD_NOT_FOUND");
  f.app.store.createRecord(f.a.user, child.id, { ...record, attachmentIds: [attachmentId] }, "linked");
  assert.equal((await f.call(client, "delete_attachment", { patientId: child.id, attachmentId, userConfirmed: true })).data.error.code, "ATTACHMENT_IN_USE");
  const another = await f.call(client, "upload_attachment", { patientId: child.id, filename: "合成未关联.png", mime: "image/png", base64: png });
  assert.equal((await f.call(client, "delete_attachment", { patientId: child.id, attachmentId: another.data.attachment.id, userConfirmed: true })).failed, false);
  assert.equal(f.app.store.listAttachments(f.a.user, child.id).length, 1);
});

test("agent share, revoke, export, audit and admin invite reuse the web rules and redact access secrets", async t => {
  const f = await fixture(t), grant = f.grant(), client = await f.connect(grant.token), child = f.app.store.createChild(f.a.user, { ...profile, validationConsent: false });
  const original = f.app.store.createRecord(f.a.user, child.id, record, "share-record"); f.app.store.confirmRecord(f.a.user, child.id, original.id, 1);
  const args = { ...instruction("share-once"), patientId: child.id, hours: 24 }, one = await f.call(client, "create_share", args), two = await f.call(client, "create_share", args);
  assert.equal(one.failed, false); assert.equal(one.data.share.url, two.data.share.url); assert.equal(f.app.store.listShares(f.a.user, child.id).length, 1);
  const token = new URL(one.data.share.url).pathname.split("/").pop()!; assert.equal(f.app.store.sharedSummary(token).records.length, 1);
  const listing = await f.call(client, "list_shares", { patientId: child.id }); assert.equal("url" in listing.data.shares[0], false); assert.equal("token" in listing.data.shares[0], false);
  assert.equal((await f.call(client, "revoke_share", { ...instruction("revoke-share"), patientId: child.id, shareId: one.data.share.id })).failed, false);
  assert.throws(() => f.app.store.sharedSummary(token), (error: unknown) => error instanceof AppError && error.status === 404);
  const exported = await f.call(client, "export_patient", { patientId: child.id, userConfirmed: true }); assert.equal(exported.data.profileRevisions.length, 1); assert.equal(exported.data.records.length, 1);
  assert.equal(JSON.stringify(exported.data).includes(grant.token), false);
  assert.equal((await f.call(client, "get_audit")).data.entries.some((entry: any) => entry.action === "agent.tool.create_share"), true);
  assert.equal((await f.call(client, "create_invite", instruction("invite-user"))).failed, false);
  assert.throws(() => f.app.store.createFamilyAgentGrant(f.b.user, { name: "不能提权", scopes: ["invites:write"], days: 1, consent: true }), (error: unknown) => error instanceof AppError && error.status === 403);
});

test("account tokens can neither expand their own permissions nor change validation consent through profile patches", async t => {
  const f = await fixture(t), client = await f.connect(f.grant(["profiles:read", "profiles:write"]).token), child = f.app.store.createChild(f.a.user, { ...profile, validationConsent: false });
  const args = { ...instruction("consent-denied"), patientId: child.id, expectedVersion: 1, enabled: true };
  assert.equal((await f.call(client, "set_validation_consent", args)).data.error.code, "AGENT_SCOPE");
  assert.equal((await f.call(client, "update_profile", { ...instruction("patch-consent"), patientId: child.id, expectedVersion: 1, reason: "不允许", patch: { validationConsent: true } })).failed, true);
  const separate = await f.connect(f.grant(["validation:consent"]).token); assert.equal((await f.call(separate, "set_validation_consent", args)).data.profile.validationConsent, true);
  assert.equal((await fetch(f.app.url + "/api/family/agent-grants", { method: "POST", headers: { Authorization: "Bearer " + f.grant().token, "Content-Type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await client.listTools()).tools.some(tool => /login|password|create.*grant|score/.test(tool.name)), false);
});

test("revocation disables initialized account clients and profile deletion revokes shares and target reads", async t => {
  const f = await fixture(t), grant = f.grant(), client = await f.connect(grant.token), child = f.app.store.createChild(f.a.user, { ...profile, validationConsent: false });
  const share = f.app.store.createShare(f.a.user, child.id, 24);
  assert.equal((await f.call(client, "delete_profile", { ...instruction("delete-patient"), patientId: child.id, expectedVersion: 1, confirmation: child.nickname })).failed, false);
  assert.equal((await f.call(client, "list_profiles")).data.profiles.length, 0);
  assert.equal((await f.call(client, "list_records", { patientId: child.id })).data.error.code, "CHILD_NOT_FOUND");
  assert.throws(() => f.app.store.sharedSummary(share.token), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.equal((await f.api("DELETE", "/agent-grants/" + grant.id, {})).status, 200);
  await assert.rejects(() => client.listTools(), /AGENT_UNAUTHORIZED/);
});

test("v2 migration retains existing single-patient credentials and encrypted data without broadening access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "family-v2-upgrade-"));
  let store: FamilyStore | undefined;
  try {
    store = new FamilyStore(dir); const user = store.register({ username: "synthetic_migrate", displayName: "合成迁移", password, consent: true }).user;
    const child = store.createChild(user, { ...profile, validationConsent: false }); const old = store.createAgentGrant(user, child.id, { name: "旧单患者", scopes: ["records:read"], days: 1, consent: true });
    const saved = store.createRecord(user, child.id, record, "old-message"); store.close(); store = undefined;
    const key = await readFile(join(dir, "key.bin")), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("child:" + child.id));
    const original = { id: child.id, createdAt: child.createdAt, nickname: child.nickname, birthYear: null, diagnosis: "", validationConsent: false };
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(original)), cipher.final()]);
    const sealed = `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
    const db = new DatabaseSync(join(dir, "family.sqlite"));
    db.prepare("UPDATE children SET payload=? WHERE id=?").run(sealed, child.id);
    db.exec("DROP TABLE agent_requests; DROP TABLE profile_revisions; PRAGMA user_version=2;"); db.close();
    store = new FamilyStore(dir); const restored = store.assertChild(user, child.id);
    assert.equal(restored.relationship, "child"); assert.equal(restored.version, 1); assert.equal(restored.updatedAt, child.createdAt);
    assert.equal(store.createRecord(user, child.id, record, "old-message").id, saved.id);
    assert.equal(store.authenticateAgent(old.token).grant.access, "patient"); assert.deepEqual(store.authenticateAgent(old.token).grant.scopes, ["records:read"]);
    assert.equal(store.profileRevisions(user, child.id).length, 1); assert.equal(store.listFamilyAgentGrants(user).length, 0);
    assert.throws(() => store!.authenticateAgent(old.token, "profiles:write"), (error: unknown) => error instanceof AppError && error.code === "AGENT_SCOPE");
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("agent idempotency rejects retargeted messages and rolls back both data and cached response on failure", async t => {
  const f = await fixture(t), grant = f.grant(), client = await f.connect(grant.token), one = f.app.store.createChild(f.a.user, { ...profile, validationConsent: false }), two = f.app.store.createChild(f.a.user, { ...profile, nickname: "合成第二位", validationConsent: false });
  const args = { messageId: "same-record-message", channel: "octop", sourceText: "合成", record, patientId: one.id };
  assert.equal((await f.call(client, "create_record_draft", args)).failed, false);
  assert.equal((await f.call(client, "create_record_draft", { ...args, patientId: two.id })).data.error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(f.app.store.listRecords(f.a.user, two.id).length, 0);
  assert.throws(() => f.app.store.agentMutation(grant.token, "profiles:write", "rollback", { action: "synthetic" }, ({ user }) => { f.app.store.createChild(user, { ...profile, nickname: "应回滚", validationConsent: false }); throw new Error("synthetic operation failure"); }), /synthetic/);
  assert.equal(f.app.store.listChildren(f.a.user).length, 2);
  const retry = f.app.store.agentMutation(grant.token, "profiles:write", "rollback", { action: "synthetic" }, () => ({ ok: true })); assert.equal(retry.ok, true);
});
