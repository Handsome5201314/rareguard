import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFamilyServer } from "../src/server/http.js";
import { DravetStore } from "../src/dravet/store.js";

// Synthetic integration records only. No production database or medical validation.
const window = { from: "2026-10-13T23:00:00+08:00", to: "2026-10-14T08:00:00+08:00", limit: 500 };
const sample = (sequence = 0, extra = {}) => ({ id: randomUUID(), sessionId: "00000000-0000-4000-8000-000000000001", sequence, kind: "hr", value: 80, unit: "bpm", sampledAt: "2026-10-14T00:05:00+08:00", receivedAt: "2026-10-14T00:05:00+08:00", timeSource: "phone_received", rawTimestamp: "unverified", quality: "unknown", source: "synthetic", ...extra });
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dravet-test-")), app = await startFamilyServer({ dataDir: dir, port: 0 });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const a = app.store.register({ username: "dravet_test_a", displayName: "合成A", password: "constructed-long-password-2026", consent: true });
  const b = app.store.register({ username: "dravet_test_b", displayName: "合成B", password: "constructed-long-password-2026", consent: true, inviteCode: app.store.createInvite(a.user).code });
  const ca = app.store.createChild(a.user, { nickname: "合成患者A", birthYear: null, diagnosis: "", validationConsent: false });
  const cb = app.store.createChild(b.user, { nickname: "合成患者B", birthYear: null, diagnosis: "", validationConsent: false });
  const pair = () => app.dravet.pair(a.user, ca.id, { name: "测试手机", model: "synthetic", protocol: "test-only", consent: true });
  const device = () => app.dravet.redeem(pair().pairingCode);
  const api = (method: string, path: string, input?: unknown, session = a, extra: Record<string, string> = {}) => fetch(app.url + path, { method, headers: { Cookie: "family_session=" + session.token, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json", ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const upload = (token: string, data: unknown, path = "/api/dravet/batches") => fetch(app.url + path, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  return { dir, app, a, b, ca, cb, pair, device, api, upload };
}

test("Dravet parent routes require session, CSRF and actual patient ownership", async t => {
  const f = await fixture(t), path = `/api/dravet/patients/${f.ca.id}/devices`;
  assert.equal((await fetch(f.app.url + path)).status, 401);
  assert.equal((await f.api("GET", path, undefined, f.b)).status, 404);
  assert.equal((await f.api("POST", path, {}, f.a, { "X-CSRF-Token": "wrong" })).status, 403);
  const paired = await f.api("POST", path, { name: "手机", model: "test", protocol: "test", consent: true });
  assert.equal(paired.status, 201);
  const data = await paired.json(); assert.equal(data.connectionPackage.kind, "dravet-device-pairing");
  assert.equal((await f.upload("", { pairingCode: data.pairingCode }, "/api/dravet/pair")).status, 201);
  assert.equal((await f.upload("", { pairingCode: data.pairingCode }, "/api/dravet/pair")).status, 401);
});
test("Pairing expiry and revoke fail closed and do not grant historical read to device", async t => {
  const f = await fixture(t), paired = f.pair();
  f.app.dravet.revoke(f.a.user, f.ca.id, paired.deviceId, "device");
  assert.throws(() => f.app.dravet.redeem(paired.pairingCode), /配对包/);
  let now = Date.parse("2026-10-14T00:00:00Z");
  const s = new DravetStore(f.app.store, join(f.dir, "expiry"), () => now);
  try { const p = s.pair(f.a.user, f.ca.id, { name: "test", model: "test", protocol: "test", consent: true }); now += 300001; assert.throws(() => s.redeem(p.pairingCode), /过期/); }
  finally { s.close(); }
  const d = f.device(); assert.throws(() => f.app.dravet.authenticate(d.token, "agent"), /凭据/);
  assert.equal((await f.api("GET", `/api/dravet/patients/${f.ca.id}/summary?${new URLSearchParams({from:window.from,to:window.to})}`, undefined, f.a, { Cookie: "", Authorization: "Bearer " + d.token })).status, 401);
});
test("Device/agent/old family credentials remain separate", async t => {
  const f = await fixture(t), d = f.device(), a = f.app.dravet.grant(f.a.user, f.ca.id, "Octop测试", 1);
  const old = f.app.store.createAgentGrant(f.a.user, f.ca.id, { name: "旧权限", scopes: ["records:read"], days: 1, consent: true });
  const data = { batchId: randomUUID(), samples: [sample()] };
  assert.equal((await f.upload(a.token, data)).status, 401); assert.equal((await f.upload(old.token, data)).status, 401);
  assert.equal((await f.upload(d.token, data)).status, 200);
  assert.equal((await fetch(f.app.url + "/mcp/family", { headers: { Authorization: "Bearer " + a.token } })).status, 401);
  assert.equal((await fetch(f.app.url + "/mcp/dravet", { headers: { Authorization: "Bearer " + old.token } })).status, 401);
});
test("Batches persist idempotently across retries; changed contents conflict", async t => {
  const f = await fixture(t), d = f.device(), data = { batchId: randomUUID(), samples: [sample()] };
  const first = await (await f.upload(d.token, data)).json(), again = await (await f.upload(d.token, data)).json();
  assert.deepEqual(again, first); assert.equal(first.inserted, 1);
  assert.equal((await f.upload(d.token, { ...data, samples: [sample()] })).status, 409);
  const dupe = await (await f.upload(d.token, { ...data, batchId: randomUUID() })).json(); assert.equal(dupe.inserted, 0); assert.equal(dupe.duplicates, 1);
});
test("Explicit renewal retains device/patient identity and batch receipts while revoking old device token", async t => {
  const f = await fixture(t), d = f.device(), data = { batchId: randomUUID(), samples: [sample(0, {hardwareId:"a".repeat(64)})] };
  const receipt = f.app.dravet.ingest(d.token, data);
  const path = `/api/dravet/patients/${f.ca.id}/devices/${d.deviceId}`;
  assert.equal((await f.api("POST", path, {consent:true}, f.b)).status,404);
  assert.equal((await f.api("POST", path, {consent:false})).status,400);
  const pack = await (await f.api("POST", path, {consent:true})).json();
  assert.equal(pack.connectionPackage.deviceId,d.deviceId); assert.equal(pack.connectionPackage.patientId,f.ca.id);
  const renewed = f.app.dravet.redeem(pack.pairingCode); assert.equal(renewed.deviceId,d.deviceId);
  assert.throws(()=>f.app.dravet.authenticate(d.token,"device"));
  assert.deepEqual(f.app.dravet.ingest(renewed.token,data),receipt);
  f.app.dravet.revoke(f.a.user,f.ca.id,d.deviceId!,"device");assert.throws(()=>f.app.dravet.renew(f.a.user,f.ca.id,d.deviceId!));
});
test("Out of order samples sort by instant across midnight and offsets, conflicts rollback entire batch", async t => {
  const f = await fixture(t), d = f.device(), late = sample(1), early = sample(0, { sampledAt: "2026-10-13T15:55:00Z" });
  f.app.dravet.ingest(d.token, { batchId: randomUUID(), samples: [late, early] });
  const r = f.app.dravet.read(f.a.user, f.ca.id, "samples", window) as { samples: {id:string}[] };
  assert.deepEqual(r.samples.map(s => s.id), [early.id, late.id]);
  assert.throws(() => f.app.dravet.ingest(d.token, { batchId: randomUUID(), samples: [sample(2), { ...late, value: 99 }] }), /不一致/);
  assert.equal((f.app.dravet.read(f.a.user, f.ca.id, "samples", window) as {samples:unknown[]}).samples.length, 2);
});
test("Reject ambiguous timestamps, units, future clock, spoofed identity and nonfinite values", async t => {
  const f = await fixture(t), d = f.device();
  for (const extra of [{ sampledAt: "2026-10-14T00:00:00" }, { unit: "g" }, { value: NaN }, { ownerId: f.b.user.id }, { receivedAt: "2099-01-01T00:00:00Z" }]) {
    assert.throws(() => f.app.dravet.ingest(d.token, { batchId: randomUUID(), samples: [sample(0, extra)] }));
  }
  assert.throws(() => f.app.dravet.grant(f.a.user, f.ca.id, "", 31));
  assert.throws(() => f.app.dravet.summary(f.a.user, f.ca.id, { ...window, to: "2026-10-30T00:00:00Z" }));
});
test("Summary separates sources, unverified quality and sessions; truncation explicit", async t => {
  const f = await fixture(t), d = f.device();
  f.app.dravet.ingest(d.token, { batchId: randomUUID(), samples: [sample(0), sample(1, { sampledAt: "2026-10-14T00:06:00+08:00" }), sample(2, { source: "replay" }), sample(3, { source: "measured", quality: "poor" }), sample(4, { sessionId: randomUUID(), sampledAt: "2026-10-14T07:00:00+08:00" })] });
  const s = f.app.dravet.summary(f.a.user, f.ca.id, window); assert.equal(s.groups.length, 3);
  const g = s.groups.find(g => g.source === "synthetic")!; assert.equal(g.largest_gap_ms, 60000); assert.equal(g.unknown_quality, 3);
  assert.equal(f.app.dravet.read(f.a.user, f.ca.id, "samples", { ...window, limit: 1 }).truncated, true);
  assert.match(s.notice, /没有记录不等于正常/);
});
test("Alarm request, sounded and caregiver acknowledgment require same device/session/source", async t => {
  const f = await fixture(t), d = f.device(), other = f.device();
  const e = { id: randomUUID(), sessionId: randomUUID(), occurredAt: "2026-10-14T00:00:00Z", kind: "alarm_requested", source: "synthetic", relatedEventId: null, ruleVersion: "test-only", note: "合成提醒" };
  f.app.dravet.event(d.token, e);
  const ack = { ...e, id: randomUUID(), kind: "caregiver_ack", relatedEventId: e.id };
  assert.throws(() => f.app.dravet.event(other.token, ack), /关联/);
  assert.throws(() => f.app.dravet.event(d.token, { ...ack, source: "measured" }), /关联/);
  assert.equal(f.app.dravet.event(d.token, ack).duplicate, false); assert.equal(f.app.dravet.event(d.token, ack).duplicate, true);
});
test("Revoke and deleting patient immediately invalidate credentials", async t => {
  const f = await fixture(t), d = f.device(), g = f.app.dravet.grant(f.a.user, f.ca.id, "test", 1);
  f.app.dravet.revoke(f.a.user, f.ca.id, d.deviceId!, "device"); assert.throws(() => f.app.dravet.authenticate(d.token, "device"), /凭据/);
  f.app.dravet.revoke(f.a.user, f.ca.id, g.id, "agent"); assert.throws(() => f.app.dravet.connection(g.token), /凭据/);
  const g2 = f.app.dravet.grant(f.a.user, f.ca.id, "test2", 1); f.app.store.deleteChild(f.a.user, f.ca.id, f.ca.nickname);
  assert.throws(() => f.app.dravet.connection(g2.token));
});
test("Monitoring payloads encrypted, restart preserves data and wrong/missing key refused", async t => {
  const f = await fixture(t), dir = join(f.dir, "restart"); let s = new DravetStore(f.app.store, dir);
  const d = s.redeem(s.pair(f.a.user, f.ca.id, { name: "sensitive-device-name", model: "test", protocol: "test", consent: true }).pairingCode);
  const data = { batchId: randomUUID(), samples: [sample()] }; s.ingest(d.token, data); s.close();
  s = new DravetStore(f.app.store, dir); assert.equal((s.read(f.a.user, f.ca.id, "samples", window) as {samples:unknown[]}).samples.length, 1); s.close();
  assert.ok(!(await readFile(join(dir, "dravet.sqlite"))).includes(Buffer.from("sensitive-device-name")));
  assert.ok(!(await readFile(join(dir, "dravet.sqlite"))).includes(Buffer.from(d.token)));
  await writeFile(join(dir, "key.bin"), Buffer.alloc(32)); assert.throws(() => new DravetStore(f.app.store, dir));
  await rm(join(dir, "key.bin")); assert.throws(() => new DravetStore(f.app.store, dir), /密钥缺失/);
});
test("Real MCP SDK discovers five readonly tools and rechecks live grants", async t => {
  const f = await fixture(t), grant = f.app.dravet.grant(f.a.user, f.ca.id, "test", 1), c = new Client({ name: "synthetic-octop", version: "1" });
  t.after(() => c.close());
  await c.connect(new StreamableHTTPClientTransport(new URL(f.app.url + "/mcp/dravet"), { requestInit: { headers: { Authorization: "Bearer " + grant.token } } }));
  const tools = await c.listTools(); assert.equal(tools.tools.length, 5); assert.ok(tools.tools.every(t => t.annotations?.readOnlyHint));
  const connection = await c.callTool({ name: "get_connection", arguments: {} }); assert.equal((connection.structuredContent as any).patient.id, f.ca.id);
  assert.equal((await c.callTool({ name: "get_samples", arguments: { ...window, ownerId: f.b.user.id } })).isError, true);
  const summary = await c.callTool({ name: "get_night_summary", arguments: window }); assert.equal(summary.isError, undefined);
  f.app.dravet.revoke(f.a.user, f.ca.id, grant.id, "agent"); await assert.rejects(c.callTool({ name: "get_connection", arguments: {} }));
});
