import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { startFamilyServer } from "../src/server/http.js";
import type { AssessmentRun, Attachment, Child, ChildInput, HealthRecord, Invite, RecordInput, RecordRevision, SessionInfo, Share, SharedSummary } from "../src/shared/types.js";

// 构造的接口测试资料；不是患者资料，也不用于医学效果验证。
const PASSWORD = "constructed-local-passphrase-2026";
const DATE = "2026-10-14";
const childInput = (validationConsent = false): ChildInput => ({ nickname: "测试代称", birthYear: null, diagnosis: "测试档案", validationConsent });
const recordInput = (overrides: Partial<RecordInput> = {}): RecordInput => ({
  kind: "lab", occurredOn: DATE, occurredTime: null, timezone: "Asia/Shanghai", title: "构造检验记录",
  notes: "仅供测试", source: "constructed-test/manual", measurements: [{ code: "ferritin", value: "685.000000000000000001", unit: "ng/mL" }], attachmentIds: [], ...overrides,
});
type Options = { csrf?: string | null; origin?: string | null; headers?: Record<string, string>; raw?: Uint8Array };

class Client {
  cookie = "";
  csrf = "";
  constructor(readonly url: string) {}
  async request<T>(method: string, path: string, payload?: unknown, options: Options = {}): Promise<{ response: Response; data: T }> {
    const headers = new Headers(options.headers);
    if (this.cookie) headers.set("Cookie", this.cookie);
    if (method !== "GET" && method !== "HEAD") {
      if (options.origin !== null) headers.set("Origin", options.origin ?? this.url);
      if (options.csrf !== null && (options.csrf ?? this.csrf)) headers.set("X-CSRF-Token", options.csrf ?? this.csrf);
    }
    let body: BodyInit | undefined;
    if (options.raw) body = new Uint8Array(options.raw).buffer;
    else if (payload !== undefined) { headers.set("Content-Type", "application/json"); body = JSON.stringify(payload); }
    const response = await fetch(`${this.url}${path}`, { method, headers, body });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies[0]!.split(";")[0]!;
    const data = response.headers.get("Content-Type")?.includes("application/json") ? await response.json() as T : undefined as T;
    if (data && typeof data === "object" && "csrfToken" in data && typeof data.csrfToken === "string") this.csrf = data.csrfToken;
    return { response, data };
  }
}
function ok(response: Response): void { assert.ok([200, 201].includes(response.status), `expected success, received HTTP ${response.status}`); }
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "family-http-test-"));
  let app = await startFamilyServer({ dataDir, port: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const admin = new Client(app.url);
  const registration = await admin.request<SessionInfo>("POST", "/api/family/register", { username: "test_admin", displayName: "测试管理员", password: PASSWORD, consent: true });
  ok(registration.response);
  const parent = new Client(app.url);
  const invitation = await admin.request<Invite>("POST", "/api/family/invites", {});
  ok(invitation.response);
  const parentRegistration = await parent.request<SessionInfo>("POST", "/api/family/register", { username: "test_parent", displayName: "测试家长", password: PASSWORD, consent: true, inviteCode: invitation.data.code });
  ok(parentRegistration.response);
  const createChild = async (client: Client, input = childInput()) => {
    const created = await client.request<{ child: Child }>("POST", "/api/family/children", input); ok(created.response); return created.data.child;
  };
  const createRecord = async (client: Client, child: Child, input = recordInput(), key = randomUUID()) => {
    const created = await client.request<{ record: HealthRecord }>("POST", `/api/family/children/${child.id}/records`, input, { headers: { "Idempotency-Key": key } }); ok(created.response); return created.data.record;
  };
  const confirm = async (client: Client, child: Child, record: HealthRecord) => {
    const confirmed = await client.request<{ record: HealthRecord }>("POST", `/api/family/children/${child.id}/records/${record.id}/confirm`, { expectedVersion: record.version, attestation: true }); ok(confirmed.response); return confirmed.data.record;
  };
  return { dataDir, admin, parent, registration, parentRegistration, invitation, createChild, createRecord, confirm,
    app: () => app,
    restart: async () => { await app.close(); app = await startFamilyServer({ dataDir, port: 0 }); return app; },
  };
}

test("bootstrap requires consent, then single-use invitation; sessions logout immediately", async (t) => {
  const f = await fixture(t);
  assert.equal(f.registration.data.user.role, "admin");
  assert.equal(f.parentRegistration.data.user.role, "parent");
  const setup = await f.admin.request<{ registrationOpen: boolean }>("GET", "/api/family/setup");
  assert.equal(setup.data.registrationOpen, false);
  const anonymous = new Client(f.app().url);
  assert.equal((await anonymous.request("GET", "/api/family/children")).response.status, 401);
  assert.equal((await anonymous.request("POST", "/api/family/register", { username: "uninvited", displayName: "测试", password: PASSWORD, consent: true })).response.status, 403);
  assert.equal((await anonymous.request("POST", "/api/family/register", { username: "reused_invite", displayName: "测试", password: PASSWORD, consent: true, inviteCode: f.invitation.data.code })).response.status, 403);
  const freshInvitation = await f.admin.request<Invite>("POST", "/api/family/invites", {});
  assert.equal((await anonymous.request("POST", "/api/family/register", { username: "no_consent", displayName: "测试", password: PASSWORD, consent: false, inviteCode: freshInvitation.data.code })).response.status, 400);
  assert.equal((await f.parent.request("POST", "/api/family/invites", {})).response.status, 403);
  assert.equal((await anonymous.request("POST", "/api/family/login", { username: "test_parent", password: "incorrect-passphrase" })).response.status, 401);
  const login = await anonymous.request<SessionInfo>("POST", "/api/family/login", { username: "test_parent", password: PASSWORD }); ok(login.response);
  const oldCookie = anonymous.cookie;
  ok((await anonymous.request("POST", "/api/family/logout", {})).response);
  anonymous.cookie = oldCookie;
  assert.equal((await anonymous.request("GET", "/api/family/session")).response.status, 401);
});

test("cookie security and CSRF reject missing tokens, incorrect tokens and foreign Origin", async (t) => {
  const f = await fixture(t);
  const cookie = f.registration.response.headers.get("Set-Cookie")!;
  assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i); assert.match(cookie, /Path=\//);
  assert.equal((await f.parent.request("POST", "/api/family/children", childInput(), { csrf: null })).response.status, 403);
  assert.equal((await f.parent.request("POST", "/api/family/children", childInput(), { csrf: "incorrect-token" })).response.status, 403);
  assert.equal((await f.parent.request("POST", "/api/family/children", childInput(), { origin: "https://untrusted.example" })).response.status, 403);
  assert.equal((await f.parent.request("POST", "/api/family/children", childInput(), { headers: { "Sec-Fetch-Site": "cross-site" } })).response.status, 403);
  const children = await f.parent.request<{ children: Child[] }>("GET", "/api/family/children"); assert.deepEqual(children.data.children, []);
});

test("different families and different children cannot guess IDs to read or change records", async (t) => {
  const f = await fixture(t), child = await f.createChild(f.admin), other = await f.createChild(f.admin);
  const record = await f.createRecord(f.admin, child);
  for (const suffix of ["records", "attachments", "shares", "export", "assessments", `records/${record.id}/revisions`]) {
    assert.equal((await f.parent.request("GET", `/api/family/children/${child.id}/${suffix}`)).response.status, 404, suffix);
  }
  assert.equal((await f.parent.request("PATCH", `/api/family/children/${child.id}`, childInput())).response.status, 404);
  assert.equal((await f.parent.request("PUT", `/api/family/children/${child.id}/records/${record.id}`, { ...recordInput(), expectedVersion: 1, reason: "测试越权" })).response.status, 404);
  assert.equal((await f.admin.request("POST", `/api/family/children/${other.id}/records/${record.id}/confirm`, { expectedVersion: 1, attestation: true })).response.status, 404);
  assert.equal((await f.parent.request<{ children: Child[] }>("GET", "/api/family/children")).data.children.length, 0);
  assert.equal((await f.admin.request<{ records: HealthRecord[] }>("GET", `/api/family/children/${child.id}/records`)).data.records.length, 1);
});

test("idempotency gives one durable record and rejects a changed payload for the same key", async (t) => {
  const f = await fixture(t), child = await f.createChild(f.parent), key = randomUUID(), input = recordInput();
  const first = await f.createRecord(f.parent, child, input, key), replay = await f.createRecord(f.parent, child, input, key);
  assert.deepEqual(replay, first);
  const changed = await f.parent.request("POST", `/api/family/children/${child.id}/records`, { ...input, notes: "不同请求" }, { headers: { "Idempotency-Key": key } });
  assert.equal(changed.response.status, 409);
  assert.equal((await f.parent.request("POST", `/api/family/children/${child.id}/records`, input)).response.status, 400);
  const listing = await f.parent.request<{ records: HealthRecord[] }>("GET", `/api/family/children/${child.id}/records`);
  assert.equal(listing.data.records.length, 1);
});

test("confirmation binds a version; editing reverts to draft and preserves revision values", async (t) => {
  const f = await fixture(t), child = await f.createChild(f.parent), original = await f.createRecord(f.parent, child);
  const confirmed = await f.confirm(f.parent, child, original);
  assert.equal(confirmed.version, 1); assert.equal(confirmed.confirmation, "user_confirmed"); assert.ok(confirmed.confirmedAt);
  const path = `/api/family/children/${child.id}/records/${original.id}`;
  const input = recordInput({ measurements: [{ code: "ferritin", value: "686.000", unit: "ng/mL" }] });
  const edit = await f.parent.request<{ record: HealthRecord }>("PUT", path, { ...input, expectedVersion: 1, reason: "核对原报告后修订" }); ok(edit.response);
  assert.equal(edit.data.record.version, 2); assert.equal(edit.data.record.confirmation, "draft"); assert.equal(edit.data.record.confirmedAt, null);
  assert.equal((await f.parent.request("POST", `${path}/confirm`, { expectedVersion: 1, attestation: true })).response.status, 409);
  assert.equal((await f.parent.request("PUT", path, { ...input, expectedVersion: 1, reason: "过期编辑" })).response.status, 409);
  assert.equal((await f.parent.request("DELETE", path, { expectedVersion: 1 })).response.status, 409);
  const revisions = await f.parent.request<{ revisions: RecordRevision[] }>("GET", `${path}/revisions`);
  assert.ok(revisions.data.revisions.some(r => r.version === 1 && r.confirmation === "user_confirmed" && r.measurements[0]?.value === original.measurements[0]?.value));
  assert.ok(revisions.data.revisions.some(r => r.version === 2 && r.reason === "核对原报告后修订"));
  assert.equal((await f.confirm(f.parent, child, edit.data.record)).confirmation, "user_confirmed");
});

test("raw precision, null time, units and dates survive; invalid temporal and missing values fail", async (t) => {
  const f = await fixture(t), child = await f.createChild(f.parent);
  assert.equal(child.birthYear, null);
  const precise = await f.createRecord(f.parent, child, recordInput({ occurredOn: "2024-02-29", occurredTime: null }));
  assert.equal(precise.measurements[0]?.value, "685.000000000000000001"); assert.equal(precise.occurredOn, "2024-02-29"); assert.equal(precise.occurredTime, null);
  for (const unit of ["mmol/L", "mg/dL"]) {
    const value = await f.createRecord(f.parent, child, recordInput({ measurements: [{ code: "triglycerides", value: "1.20", unit }] }));
    assert.equal(value.measurements[0]?.unit, unit); assert.equal(value.measurements[0]?.value, "1.20");
  }
  for (const invalid of [
    recordInput({ occurredOn: "2026-02-30" }), recordInput({ occurredTime: "25:00" }), recordInput({ timezone: "Invalid/Timezone" }),
    recordInput({ source: "" }), recordInput({ measurements: [] }), recordInput({ measurements: [{ code: "ferritin", value: " ", unit: "ng/mL" }] }),
    recordInput({ measurements: [{ code: "ferritin", value: "100", unit: "kg" }] }),
  ]) {
    assert.equal((await f.parent.request("POST", `/api/family/children/${child.id}/records`, invalid, { headers: { "Idempotency-Key": randomUUID() } })).response.status, 400);
  }
  assert.equal((await f.parent.request<{ records: HealthRecord[] }>("GET", `/api/family/children/${child.id}/records`)).data.records.length, 3);
});

test("attachments check magic, size, ownership and never disclose a private storage path", async (t) => {
  const f = await fixture(t), child = await f.createChild(f.parent), adminChild = await f.createChild(f.admin);
  const path = `/api/family/children/${child.id}/attachments`;
  const pdf = Buffer.from("%PDF-1.7\nconstructed-test-only\n%%EOF\n");
  const upload = await f.parent.request<{ attachment: Attachment }>("POST", path, undefined, { raw: pdf, headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent("构造报告.pdf") } }); ok(upload.response);
  assert.equal(upload.data.attachment.size, pdf.length); assert.equal(upload.data.attachment.filename, "构造报告.pdf");
  assert.equal("storagePath" in upload.data.attachment, false);
  const downloadPath = `${path}/${upload.data.attachment.id}`;
  const download = await f.parent.request("GET", downloadPath); ok(download.response);
  assert.match(download.response.headers.get("Content-Disposition")!, /^attachment;/);
  assert.equal(download.response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(Buffer.from(await download.response.arrayBuffer()), pdf);
  assert.equal((await f.admin.request("GET", downloadPath)).response.status, 404);
  assert.equal((await f.admin.request("GET", `/api/family/children/${adminChild.id}/attachments/${upload.data.attachment.id}`)).response.status, 404);
  assert.equal((await new Client(f.app().url).request("GET", downloadPath)).response.status, 401);
  assert.equal((await f.parent.request("POST", path, undefined, { raw: pdf, headers: { "Content-Type": "image/png", "X-Filename": "wrong.png" } })).response.status, 415);
  assert.equal((await f.parent.request("POST", path, undefined, { raw: Buffer.from("not-a-file"), headers: { "Content-Type": "application/pdf", "X-Filename": "wrong.pdf" } })).response.status, 415);
  assert.equal((await f.parent.request("POST", path, undefined, { raw: Buffer.alloc(8 * 1024 * 1024 + 1), headers: { "Content-Type": "application/pdf", "X-Filename": "large.pdf" } })).response.status, 413);
  const encryptedFiles = await readdir(join(f.dataDir, "attachments"));
  assert.equal(encryptedFiles.length, 1);
  assert.equal((await readFile(join(f.dataDir, "attachments", encryptedFiles[0]!))).includes(pdf), false);
});

test("failed deletion of a bound or historically bound attachment keeps the original downloadable", async (t) => {
  const f = await fixture(t), child = await f.createChild(f.parent), pdf = Buffer.from("%PDF-1.7\nattachment-source\n%%EOF\n");
  const upload = await f.parent.request<{ attachment: Attachment }>("POST", `/api/family/children/${child.id}/attachments`, undefined, { raw: pdf, headers: { "Content-Type": "application/pdf", "X-Filename": "source.pdf" } }); ok(upload.response);
  const path = `/api/family/children/${child.id}/attachments/${upload.data.attachment.id}`;
  const record = await f.createRecord(f.parent, child, recordInput({ attachmentIds: [upload.data.attachment.id] }));
  assert.equal((await f.parent.request("DELETE", path)).response.status, 409);
  const retained = await f.parent.request("GET", path); assert.equal(retained.response.status, 200); assert.deepEqual(Buffer.from(await retained.response.arrayBuffer()), pdf);
  const detached = await f.parent.request<{ record: HealthRecord }>("PUT", `/api/family/children/${child.id}/records/${record.id}`, { ...recordInput(), expectedVersion: 1, reason: "当前记录移除附件" }); ok(detached.response);
  assert.equal((await f.parent.request("DELETE", path)).response.status, 409);
  const historical = await f.parent.request("GET", path); assert.equal(historical.response.status, 200); assert.deepEqual(Buffer.from(await historical.response.arrayBuffer()), pdf);
});

test("swapping encrypted files cannot silently substitute another child's attachment", async (t) => {
  const f = await fixture(t), firstChild = await f.createChild(f.parent), secondChild = await f.createChild(f.parent, { ...childInput(), nickname: "另一测试代称" });
  const firstPdf = Buffer.from("%PDF-1.7\nfirst-constructed-source\n%%EOF\n"), secondPdf = Buffer.from("%PDF-1.7\nsecond-constructed-source\n%%EOF\n");
  const upload = async (child: Child, raw: Buffer, filename: string) => {
    const result = await f.parent.request<{ attachment: Attachment }>("POST", `/api/family/children/${child.id}/attachments`, undefined, { raw, headers: { "Content-Type": "application/pdf", "X-Filename": filename } }); ok(result.response); return result.data.attachment;
  };
  const first = await upload(firstChild, firstPdf, "first.pdf"), second = await upload(secondChild, secondPdf, "second.pdf");
  const firstFile = join(f.dataDir, "attachments", `${first.id}.bin`), secondFile = join(f.dataDir, "attachments", `${second.id}.bin`);
  const firstEncrypted = await readFile(firstFile), secondEncrypted = await readFile(secondFile);
  await writeFile(firstFile, secondEncrypted); await writeFile(secondFile, firstEncrypted);
  const firstDownload = await f.parent.request("GET", `/api/family/children/${firstChild.id}/attachments/${first.id}`);
  const secondDownload = await f.parent.request("GET", `/api/family/children/${secondChild.id}/attachments/${second.id}`);
  assert.equal(firstDownload.response.status, 500); assert.equal(secondDownload.response.status, 500);
});

test("public sharing includes only confirmed records and loses access after revoke or child deletion", async (t) => {
  const f = await fixture(t), child = await f.createChild(f.parent);
  const confirmed = await f.confirm(f.parent, child, await f.createRecord(f.parent, child));
  await f.createRecord(f.parent, child, recordInput({ title: "未确认草稿" }));
  const response = await f.parent.request<{ share: Share }>("POST", `/api/family/children/${child.id}/shares`, { hours: 24 }); ok(response.response);
  assert.ok(response.data.share.url);
  const token = new URL(response.data.share.url).pathname.split("/").at(-1)!;
  const anonymous = new Client(f.app().url), sharedPath = `/api/family/shared/${token}`;
  const summary = await anonymous.request<SharedSummary>("GET", sharedPath); ok(summary.response);
  assert.equal(summary.data.records.length, 1); assert.equal(summary.data.records[0]?.id, confirmed.id);
  for (const field of ["source", "attachmentIds", "revisions", "assessment", "result", "changedBy"]) assert.equal(field in summary.data.records[0]!, false, field);
  assert.deepEqual(Object.keys(summary.data.child).sort(), ["diagnosis", "nickname"]);
  const shares = await f.parent.request<{ shares: Share[] }>("GET", `/api/family/children/${child.id}/shares`);
  assert.equal("url" in shares.data.shares[0]!, false); assert.equal("token" in shares.data.shares[0]!, false);
  assert.equal((await f.admin.request("DELETE", `/api/family/children/${child.id}/shares/${response.data.share.id}`)).response.status, 404);
  ok((await f.parent.request("DELETE", `/api/family/children/${child.id}/shares/${response.data.share.id}`)).response);
  assert.equal((await anonymous.request("GET", sharedPath)).response.status, 404);
  const second = await f.parent.request<{ share: Share }>("POST", `/api/family/children/${child.id}/shares`, { hours: 24 }); ok(second.response);
  const secondToken = new URL(second.data.share.url!).pathname.split("/").at(-1)!;
  assert.equal((await f.parent.request("DELETE", `/api/family/children/${child.id}`, { confirmation: "错误代称" })).response.status, 400);
  ok((await f.parent.request("DELETE", `/api/family/children/${child.id}`, { confirmation: child.nickname })).response);
  assert.equal((await anonymous.request("GET", `/api/family/shared/${secondToken}`)).response.status, 404);
});

test("records and sessions survive a real HTTP server restart and export omits credentials", async (t) => {
  const f = await fixture(t), child = await f.createChild(f.parent);
  const record = await f.confirm(f.parent, child, await f.createRecord(f.parent, child));
  const cookie = f.parent.cookie, csrf = f.parent.csrf;
  const app = await f.restart(), parent = new Client(app.url); parent.cookie = cookie; parent.csrf = csrf;
  const session = await parent.request<SessionInfo>("GET", "/api/family/session"); ok(session.response); assert.equal(session.data.user.id, f.parentRegistration.data.user.id);
  const listing = await parent.request<{ records: HealthRecord[] }>("GET", `/api/family/children/${child.id}/records`); ok(listing.response); assert.deepEqual(listing.data.records, [record]);
  const exported = await parent.request<{ formatVersion: number; records: HealthRecord[]; revisions: RecordRevision[] }>("GET", `/api/family/children/${child.id}/export`); ok(exported.response);
  assert.equal(exported.data.formatVersion, 1); assert.equal(exported.data.records.length, 1); assert.ok(exported.data.revisions.length >= 2);
  const serialized = JSON.stringify(exported.data); assert.equal(serialized.includes(PASSWORD), false); assert.equal(serialized.includes(csrf), false); assert.equal(serialized.includes(cookie), false);
});

test("internal rules require admin, explicit consent and current confirmed same-day records; edits stale results", async (t) => {
  const f = await fixture(t), parentChild = await f.createChild(f.parent, childInput(true)), child = await f.createChild(f.admin), path = `/api/family/children/${child.id}/assessments`;
  assert.equal((await f.parent.request("GET", `/api/family/children/${parentChild.id}/assessments`)).response.status, 403);
  assert.equal((await f.parent.request("POST", `/api/family/children/${parentChild.id}/assessments`, {})).response.status, 403);
  assert.equal((await f.admin.request("GET", path)).response.status, 403);
  ok((await f.admin.request("PATCH", `/api/family/children/${child.id}`, { ...childInput(true), expectedVersion: child.version })).response);
  const record = await f.createRecord(f.admin, child, recordInput({ measurements: [
    { code: "ferritin", value: "685", unit: "ng/mL" }, { code: "platelets", value: "181", unit: "10^9/L" }, { code: "ast", value: "48", unit: "U/L" },
    { code: "triglycerides", value: "156", unit: "mg/dL" }, { code: "fibrinogen", value: "3.6", unit: "g/L" },
  ] }));
  const finding = { state: "present", observedAt: DATE, source: "constructed-test/clinical", confirmation: "confirmed" };
  const input = { scaleId: "mas_2016", assessmentDate: DATE, recordIds: [record.id], context: { fever: finding, knownOrSuspectedSjia: finding, alternativeCausesExcluded: finding } };
  assert.equal((await f.admin.request("POST", path, input)).response.status, 409);
  await f.confirm(f.admin, child, record);
  assert.equal((await f.admin.request("POST", path, { ...input, assessmentDate: "2026-10-13" })).response.status, 400);
  assert.equal((await f.admin.request("POST", path, { ...input, recordIds: [record.id, record.id] })).response.status, 400);
  const scored = await f.admin.request<{ assessment: AssessmentRun }>("POST", path, input); ok(scored.response);
  assert.equal(scored.data.assessment.stale, false); assert.deepEqual(scored.data.assessment.inputVersions, [{ id: record.id, version: 1 }]);
  const result = scored.data.assessment.result as { scaleId: string; clinicalReviewStatus: string };
  assert.equal(result.scaleId, "mas_2016"); assert.equal(result.clinicalReviewStatus, "not_signed_off");
  ok((await f.admin.request("PUT", `/api/family/children/${child.id}/records/${record.id}`, { ...recordInput(), expectedVersion: 1, reason: "内部验证后修订" })).response);
  const runs = await f.admin.request<{ assessments: AssessmentRun[] }>("GET", path); assert.equal(runs.data.assessments[0]?.stale, true);
  const familyListing = await f.admin.request<{ records: HealthRecord[] }>("GET", `/api/family/children/${child.id}/records`);
  assert.equal("result" in familyListing.data.records[0]!, false); assert.equal("assessment" in familyListing.data.records[0]!, false);
});
