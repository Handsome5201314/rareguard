import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { AppError, FamilyStore } from "../src/server/store.js";
import type { ChildInput, RecordInput, User } from "../src/shared/types.js";

// Constructed fixtures exercise storage boundaries; they are not clinical validation data.
const PASSWORD = "constructed-store-passphrase-2026";
const DATE = "2026-10-14";
const childInput = (validationConsent = true): ChildInput => ({ nickname: "构造孩子私有代称", birthYear: null, diagnosis: "构造诊断私有资料", validationConsent });
const recordInput = (overrides: Partial<RecordInput> = {}): RecordInput => ({
  kind: "lab", occurredOn: DATE, occurredTime: null, timezone: "Asia/Shanghai", title: "构造私有检验标题",
  notes: "构造病程隐私内容仅供测试", source: "构造私有来源", measurements: [{ code: "ferritin", value: "685.000000000000000001", unit: "ng/mL" }], attachmentIds: [], ...overrides,
});

function error(status: number, code?: string) {
  return (value: unknown): boolean => value instanceof AppError && value.status === status && (!code || value.code === code);
}

function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "family-store-test-"));
  let store = new FamilyStore(dataDir);
  let open = true;
  t.after(() => { if (open) store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const adminSession = store.register({ username: "test_admin", displayName: "测试管理员", password: PASSWORD, consent: true });
  const invite = store.createInvite(adminSession.user);
  const parentSession = store.register({ username: "test_parent", displayName: "测试家长", password: PASSWORD, consent: true, inviteCode: invite.code });
  return {
    dataDir, admin: adminSession.user, parent: parentSession.user, adminSession, parentSession,
    store: () => store,
    close: () => { store.close(); open = false; },
    restart: () => { if (open) store.close(); open = false; store = new FamilyStore(dataDir); open = true; return store; },
  };
}

function withDatabase<T>(dataDir: string, action: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(join(dataDir, "family.sqlite"));
  try { return action(database); } finally { database.close(); }
}

test("registration requires consent and a 12-character password; bootstrap and invitations are explicit", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "family-bootstrap-test-")), store = new FamilyStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.setup().registrationOpen, true);
  assert.throws(() => store.register({ username: "short", displayName: "测试", password: "12345678901", consent: true }), error(400));
  assert.throws(() => store.register({ username: "中文用户名", displayName: "测试", password: PASSWORD, consent: true }), error(400));
  assert.throws(() => store.register({ username: "no_consent", displayName: "测试", password: PASSWORD, consent: false } as never), error(400));
  const first = store.register({ username: "ADMIN", displayName: "测试", password: PASSWORD, consent: true });
  assert.equal(first.user.role, "admin"); assert.equal(first.user.username, "admin"); assert.equal(store.setup().registrationOpen, false);
  assert.throws(() => store.register({ username: "uninvited", displayName: "测试", password: PASSWORD, consent: true }), error(403));
  const invitation = store.createInvite(first.user);
  const parent = store.register({ username: "parent", displayName: "测试", password: PASSWORD, consent: true, inviteCode: invitation.code });
  assert.equal(parent.user.role, "parent");
  assert.throws(() => store.register({ username: "reused", displayName: "测试", password: PASSWORD, consent: true, inviteCode: invitation.code }), error(403));
  assert.throws(() => store.createInvite({ ...parent.user, role: "admin" }), error(403));
  assert.throws(() => store.register({ username: "PARENT", displayName: "测试", password: PASSWORD, consent: true }), error(409));
});

test("sessions persist, expire after a fixed seven days, and logout invalidates their stored hash", (t) => {
  const f = fixture(t), store = f.store();
  assert.throws(() => store.login({ username: "test_parent", password: "wrong-password" }), error(401));
  assert.throws(() => store.login({ username: "unknown_user", password: "wrong-password" }), error(401));
  const login = store.login({ username: "TEST_PARENT", password: PASSWORD });
  assert.equal(login.user.id, f.parent.id);
  assert.deepEqual(store.authenticate(login.token), { user: login.user, csrfToken: login.csrfToken });
  const row = withDatabase(f.dataDir, db => db.prepare("SELECT token_hash,expires_at,created_at FROM sessions WHERE token_hash=?").get(createHash("sha256").update(login.token).digest("hex")))!;
  assert.equal(Date.parse(String(row.expires_at)) - Date.parse(String(row.created_at)), 7 * 24 * 60 * 60 * 1000);
  assert.notEqual(row.token_hash, login.token);
  const restarted = f.restart();
  assert.equal(restarted.authenticate(login.token)?.user.id, f.parent.id);
  restarted.logout(login.token);
  assert.equal(restarted.authenticate(login.token), null);
  withDatabase(f.dataDir, db => db.prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").run(f.parent.id));
  assert.equal(restarted.authenticate(f.parentSession.token), null);
  assert.equal(restarted.authenticate("unknown-token"), null);
});

test("encryption preserves raw precision across a reopen and leaves no clinical plaintext in SQLite", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.admin, childInput());
  const record = store.confirmRecord(f.admin, child.id, store.createRecord(f.admin, child.id, recordInput(), randomUUID()).id, 1);
  const result = { clinicalSummary: "构造内部验证敏感结果", preciseValue: "123.456000000000001" };
  store.saveAssessment(f.admin, child.id, { scaleId: "test_scale", assessmentDate: DATE, inputVersions: [{ id: record.id, version: 1 }], result });
  store.addAttachment(f.admin, child.id, { id: randomUUID(), filename: "构造私有报告名.pdf", mime: "application/pdf", size: 20, storagePath: join(f.dataDir, "private-constructed-path") });
  f.close();
  const buffers = readdirSync(f.dataDir).filter(name => name.startsWith("family.sqlite")).map(name => readFileSync(join(f.dataDir, name)));
  const onDisk = Buffer.concat(buffers);
  for (const secret of [child.nickname, child.diagnosis, record.title, record.notes, record.source, record.measurements[0]!.value, result.clinicalSummary, "构造私有报告名.pdf", PASSWORD, f.adminSession.token]) {
    assert.equal(onDisk.includes(Buffer.from(secret)), false, `must not persist plaintext: ${secret}`);
  }
  const reopened = f.restart();
  assert.deepEqual(reopened.listRecords(f.admin, child.id), [record]);
  assert.deepEqual(reopened.listAssessments(f.admin, child.id)[0]?.result, result);
  assert.equal(readFileSync(join(f.dataDir, "key.bin")).length, 32);
  assert.equal(withDatabase(f.dataDir, db => db.prepare("PRAGMA user_version").get())?.user_version, 3);
});

test("missing or wrong keys fail closed for a nonempty database", (t) => {
  const f = fixture(t), child = f.store().createChild(f.parent, childInput(false));
  f.store().createRecord(f.parent, child.id, recordInput(), randomUUID()); f.close();
  const keyPath = join(f.dataDir, "key.bin"), originalKey = readFileSync(keyPath);
  unlinkSync(keyPath);
  assert.throws(() => new FamilyStore(f.dataDir), /密钥缺失/);
  assert.equal(existsSync(keyPath), false);
  writeFileSync(keyPath, randomBytes(32));
  assert.throws(() => new FamilyStore(f.dataDir), /无法解密|校验失败/);
  writeFileSync(keyPath, originalKey);
  assert.equal(f.restart().listRecords(f.parent, child.id).length, 1);
});

test("object ownership rejects guessed IDs, cross-child attachments and forged administrator roles", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.admin, childInput()), otherChild = store.createChild(f.admin, childInput());
  const parentChild = store.createChild(f.parent, childInput()), record = store.createRecord(f.admin, child.id, recordInput(), randomUUID());
  const attachment = store.addAttachment(f.admin, child.id, { id: randomUUID(), filename: "test.pdf", mime: "application/pdf", size: 5, storagePath: join(f.dataDir, "constructed-file") });
  for (const operation of [
    () => store.assertChild(f.parent, child.id), () => store.listRecords(f.parent, child.id), () => store.exportChild(f.parent, child.id),
    () => store.revisions(f.parent, child.id, record.id), () => store.updateChild(f.parent, child.id, childInput(), child.version),
    () => store.updateRecord(f.parent, child.id, record.id, recordInput(), 1, "构造越权"),
    () => store.confirmRecord(f.admin, otherChild.id, record.id, 1),
    () => store.getAttachment(f.parent, child.id, attachment.id), () => store.getAttachment(f.admin, otherChild.id, attachment.id),
    () => store.createRecord(f.parent, parentChild.id, recordInput({ attachmentIds: [attachment.id] }), randomUUID()),
    () => store.createRecord(f.admin, otherChild.id, recordInput({ attachmentIds: [attachment.id] }), randomUUID()),
    () => store.listShares(f.parent, child.id), () => store.listAssessments(f.parent, child.id),
  ]) assert.throws(operation, error(404));
  assert.throws(() => store.listAssessments({ ...f.parent, role: "admin" }, parentChild.id), error(403));
  assert.throws(() => store.createInvite({ ...f.parent, role: "admin" }), error(403));
  assert.deepEqual(store.listRecords(f.parent, parentChild.id), []);
});

test("idempotency is durable; confirmation binds its version and edits retain previous values", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.parent, childInput(false)), input = recordInput(), key = randomUUID();
  const first = store.createRecord(f.parent, child.id, input, key);
  assert.deepEqual(store.createRecord(f.parent, child.id, input, key), first);
  assert.throws(() => store.createRecord(f.parent, child.id, recordInput({ notes: "different" }), key), error(409, "IDEMPOTENCY_CONFLICT"));
  assert.throws(() => store.createRecord(f.parent, child.id, input, ""), error(400));
  const confirmed = store.confirmRecord(f.parent, child.id, first.id, 1);
  assert.equal(confirmed.version, 1); assert.equal(confirmed.confirmation, "user_confirmed"); assert.ok(confirmed.confirmedAt);
  assert.deepEqual(store.confirmRecord(f.parent, child.id, first.id, 1), confirmed);
  const updated = store.updateRecord(f.parent, child.id, first.id, recordInput({ measurements: [{ code: "ferritin", value: "<1.000", unit: "ng/mL" }] }), 1, "根据原报告订正");
  assert.equal(updated.version, 2); assert.equal(updated.confirmation, "draft"); assert.equal(updated.confirmedAt, null);
  assert.throws(() => store.confirmRecord(f.parent, child.id, first.id, 1), error(409, "VERSION_CONFLICT"));
  assert.throws(() => store.updateRecord(f.parent, child.id, first.id, input, 1, "过期修改"), error(409));
  const revisions = store.revisions(f.parent, child.id, first.id);
  assert.ok(revisions.some(revision => revision.version === 1 && revision.measurements[0]?.value === input.measurements[0]?.value));
  assert.ok(revisions.some(revision => revision.version === 2 && revision.reason === "根据原报告订正"));
  const reopened = f.restart();
  assert.deepEqual(reopened.createRecord(f.parent, child.id, input, key), first);
  assert.equal(reopened.listRecords(f.parent, child.id)[0]?.version, 2);
  reopened.deleteRecord(f.parent, child.id, first.id, 2);
  assert.deepEqual(reopened.listRecords(f.parent, child.id), []);
  assert.ok(reopened.revisions(f.parent, child.id, first.id).some(revision => revision.reason === "删除记录"));
});

test("two database connections cannot overwrite a newer record with a stale version", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.parent, childInput(false));
  const first = store.createRecord(f.parent, child.id, recordInput(), randomUUID()), secondConnection = new FamilyStore(f.dataDir);
  try {
    store.updateRecord(f.parent, child.id, first.id, recordInput({ notes: "first-writer" }), 1, "first edit");
    assert.throws(() => secondConnection.updateRecord(f.parent, child.id, first.id, recordInput({ notes: "second-writer" }), 1, "second edit"), error(409));
    assert.equal(secondConnection.listRecords(f.parent, child.id)[0]?.notes, "first-writer");
  } finally { secondConnection.close(); }
});

test("required source, valid dates, explicit units and unique metrics are enforced without changing raw values", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.parent, { ...childInput(false), diagnosis: "" });
  assert.equal(child.diagnosis, "");
  for (const invalid of [
    recordInput({ occurredOn: "2026-02-30" }), recordInput({ occurredTime: "24:00" }), recordInput({ timezone: "Bad/Timezone" }),
    recordInput({ source: " " }), recordInput({ measurements: [] }), recordInput({ measurements: [{ code: "ferritin", value: " ", unit: "ng/mL" }] }),
    recordInput({ measurements: [{ code: "ferritin", value: "1", unit: "kg" }] }),
    recordInput({ measurements: [{ code: "ferritin", value: "1", unit: "ng/mL" }, { code: "ferritin", value: "2", unit: "ng/mL" }] }),
  ]) assert.throws(() => store.createRecord(f.parent, child.id, invalid, randomUUID()), error(400));
  const raw = store.createRecord(f.parent, child.id, recordInput({ occurredOn: "2024-02-29", occurredTime: "09:05:07", measurements: [{ code: "ferritin", value: " >685.000 ", unit: "ng/mL" }] }), randomUUID());
  assert.equal(raw.measurements[0]?.value, " >685.000 "); assert.equal(raw.occurredTime, "09:05:07");
  assert.throws(() => store.createChild(f.parent, { ...childInput(), birthYear: new Date().getUTCFullYear() + 1 }), error(400));
  assert.equal(store.listRecords(f.parent, child.id).length, 1);
});

test("attachment metadata is private, and bound or historically bound source documents cannot be deleted", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.parent, childInput(false));
  for (const storagePath of [f.dataDir, resolve(f.dataDir, "..", "constructed-escape"), "../constructed-escape", "..\\constructed-escape"]) {
    assert.throws(() => store.addAttachment(f.parent, child.id, { id: randomUUID(), filename: "source.pdf", mime: "application/pdf", size: 20, storagePath }), error(400, "INVALID_ATTACHMENT_PATH"));
  }
  const add = () => store.addAttachment(f.parent, child.id, { id: randomUUID(), filename: "source.pdf", mime: "application/pdf", size: 20, storagePath: join(f.dataDir, randomUUID()) });
  const unbound = add(); assert.equal("storagePath" in unbound, false); assert.equal("storagePath" in store.listAttachments(f.parent, child.id)[0]!, false);
  const privatePath = store.getAttachment(f.parent, child.id, unbound.id).storagePath;
  assert.deepEqual(store.deleteAttachment(f.parent, child.id, unbound.id), { storagePath: privatePath });
  assert.throws(() => store.getAttachment(f.parent, child.id, unbound.id), error(404));
  const bound = add(), record = store.createRecord(f.parent, child.id, recordInput({ attachmentIds: [bound.id] }), randomUUID());
  assert.throws(() => store.deleteAttachment(f.parent, child.id, bound.id), error(409, "ATTACHMENT_IN_USE"));
  store.updateRecord(f.parent, child.id, record.id, recordInput(), 1, "当前版本不再关联");
  assert.throws(() => store.deleteAttachment(f.parent, child.id, bound.id), error(409));
  store.deleteRecord(f.parent, child.id, record.id, 2);
  assert.throws(() => store.deleteAttachment(f.parent, child.id, bound.id), error(409));
  assert.equal(store.getAttachment(f.parent, child.id, bound.id).id, bound.id);
});

test("public shares expose only confirmed projections and expire or revoke without exposing tokens in listing", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.parent, childInput(false));
  const record = store.createRecord(f.parent, child.id, recordInput(), randomUUID());
  const confirmed = store.confirmRecord(f.parent, child.id, record.id, 1);
  store.createRecord(f.parent, child.id, recordInput({ title: "unconfirmed" }), randomUUID());
  const share = store.createShare(f.parent, child.id, 24), summary = store.sharedSummary(share.token);
  assert.equal(summary.records.length, 1); assert.equal(summary.records[0]?.id, confirmed.id);
  assert.deepEqual(Object.keys(summary.child).sort(), ["diagnosis", "nickname"]);
  assert.deepEqual(Object.keys(summary.records[0]!).sort(), ["confirmation", "id", "kind", "measurements", "notes", "occurredOn", "occurredTime", "timezone", "title"].sort());
  assert.equal("token" in store.listShares(f.parent, child.id)[0]!, false); assert.equal("url" in store.listShares(f.parent, child.id)[0]!, false);
  store.revokeShare(f.parent, child.id, share.id); assert.throws(() => store.sharedSummary(share.token), error(404));
  const expired = store.createShare(f.parent, child.id, 24);
  withDatabase(f.dataDir, db => db.prepare("UPDATE shares SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired.id));
  assert.throws(() => store.sharedSummary(expired.token), error(404));
  assert.throws(() => store.createShare(f.parent, child.id, 1), error(400));
});

test("internal assessment snapshots need owner-admin consent, confirmed same-day current versions and become stale", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.admin, childInput(false)), parentChild = store.createChild(f.parent, childInput());
  assert.throws(() => store.listAssessments(f.admin, child.id), error(403));
  assert.throws(() => store.listAssessments(f.parent, parentChild.id), error(403));
  store.updateChild(f.admin, child.id, childInput(), child.version);
  const original = store.createRecord(f.admin, child.id, recordInput(), randomUUID());
  const assessmentInput = { scaleId: "test_scale", assessmentDate: DATE, inputVersions: [{ id: original.id, version: 1 }], result: { constructed: true } };
  assert.throws(() => store.saveAssessment(f.admin, child.id, assessmentInput), error(409));
  store.confirmRecord(f.admin, child.id, original.id, 1);
  assert.throws(() => store.getSelectedRecords(f.admin, child.id, [original.id], "2026-10-13"), error(400));
  assert.throws(() => store.getSelectedRecords(f.admin, child.id, [original.id, original.id], DATE), error(400));
  assert.throws(() => store.saveAssessment(f.admin, child.id, { ...assessmentInput, inputVersions: [{ id: original.id, version: 2 }] }), error(409));
  const assertStale = () => assert.equal(store.listAssessments(f.admin, child.id).every(run => run.stale), true);
  const first = store.saveAssessment(f.admin, child.id, assessmentInput); assert.equal(first.stale, false);
  const additional = store.createRecord(f.admin, child.id, recordInput({ title: "新增同日资料" }), randomUUID()); assertStale();
  store.saveAssessment(f.admin, child.id, assessmentInput);
  store.confirmRecord(f.admin, child.id, additional.id, 1); assertStale();
  store.saveAssessment(f.admin, child.id, assessmentInput);
  const updated = store.updateRecord(f.admin, child.id, additional.id, recordInput(), 1, "改动非所选记录"); assertStale();
  store.saveAssessment(f.admin, child.id, assessmentInput);
  store.deleteRecord(f.admin, child.id, additional.id, updated.version); assertStale();
  store.saveAssessment(f.admin, child.id, assessmentInput);
  store.updateChild(f.admin, child.id, childInput(false), store.assertChild(f.admin, child.id).version);
  assert.throws(() => store.listAssessments(f.admin, child.id), error(403));
  store.updateChild(f.admin, child.id, childInput(true), store.assertChild(f.admin, child.id).version); assertStale();
});

test("child deletion revokes all access and shares while audit stays free of clinical text", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.parent, childInput(false));
  const record = store.createRecord(f.parent, child.id, recordInput(), randomUUID()), share = store.createShare(f.parent, child.id, 24);
  const exported = store.exportChild(f.parent, child.id);
  assert.equal(exported.formatVersion, 1); assert.equal(exported.records.length, 1); assert.equal(exported.revisions.length, 1);
  assert.equal(JSON.stringify(exported).includes(PASSWORD), false); assert.equal(JSON.stringify(exported).includes(f.parentSession.token), false);
  assert.throws(() => store.deleteChild(f.parent, child.id, "wrong"), error(400));
  store.deleteChild(f.parent, child.id, child.nickname);
  assert.throws(() => store.assertChild(f.parent, child.id), error(404)); assert.throws(() => store.sharedSummary(share.token), error(404));
  assert.deepEqual(store.listChildren(f.parent), []);
  const audit = store.audit(f.parent); assert.ok(audit.some(entry => entry.action === "child.delete"));
  assert.equal(JSON.stringify(audit).includes(record.notes), false); assert.equal(JSON.stringify(audit).includes(record.measurements[0]!.value), false);
  assert.ok(audit.every(entry => !store.audit(f.admin).some(adminEntry => adminEntry.id === entry.id)));
  assert.throws(() => store.listChildren({ id: randomUUID() } as User), error(401));
});

test("encrypted record tampering raises a visible integrity error", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.parent, childInput(false));
  const record = store.createRecord(f.parent, child.id, recordInput(), randomUUID());
  withDatabase(f.dataDir, db => {
    const row = db.prepare("SELECT payload FROM records WHERE id=?").get(record.id)!;
    const parts = String(row.payload).split(".");
    const ciphertext = Buffer.from(parts[3]!, "base64url"); ciphertext[0] = ciphertext[0]! ^ 1; parts[3] = ciphertext.toString("base64url");
    db.prepare("UPDATE records SET payload=? WHERE id=?").run(parts.join("."), record.id);
  });
  assert.throws(() => store.listRecords(f.parent, child.id), /无法解密|校验失败/);
});

test("a stopped full-directory backup restores records, sessions and attachments at a different path", (t) => {
  const f = fixture(t), store = f.store(), child = store.createChild(f.parent, childInput(false));
  const id = randomUUID(), attachmentDirectory = join(f.dataDir, "attachments"), originalPath = join(attachmentDirectory, `${id}.bin`);
  mkdirSync(attachmentDirectory);
  const original = Buffer.from("%PDF-1.7\nconstructed-backup-roundtrip-source\n%%EOF\n"), key = readFileSync(join(f.dataDir, "key.bin")), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(`attachment:${child.id}:${id}`));
  writeFileSync(originalPath, Buffer.concat([iv, cipher.update(original), cipher.final(), cipher.getAuthTag()]));
  const attachment = store.addAttachment(f.parent, child.id, { id, filename: "backup-source.pdf", mime: "application/pdf", size: original.length, storagePath: originalPath });
  const record = store.createRecord(f.parent, child.id, recordInput({ attachmentIds: [id] }), randomUUID());
  const confirmed = store.confirmRecord(f.parent, child.id, record.id, 1), revisions = store.revisions(f.parent, child.id, record.id);
  f.close();
  const restoredDirectory = mkdtempSync(join(tmpdir(), "family-restored-test-"));
  cpSync(f.dataDir, restoredDirectory, { recursive: true });
  rmSync(f.dataDir, { recursive: true, force: true });
  const restored = new FamilyStore(restoredDirectory);
  t.after(() => { restored.close(); rmSync(restoredDirectory, { recursive: true, force: true }); });
  assert.deepEqual(restored.listChildren(f.parent), [child]);
  assert.deepEqual(restored.listRecords(f.parent, child.id), [confirmed]);
  assert.deepEqual(restored.revisions(f.parent, child.id, record.id), revisions);
  assert.deepEqual(restored.authenticate(f.parentSession.token), { user: f.parent, csrfToken: f.parentSession.csrfToken });
  assert.deepEqual(restored.listAttachments(f.parent, child.id), [attachment]);
  const file = restored.getAttachment(f.parent, child.id, id);
  assert.equal(file.storagePath, join(restoredDirectory, "attachments", `${id}.bin`));
  const encrypted = readFileSync(file.storagePath), decipher = createDecipheriv("aes-256-gcm", readFileSync(join(restoredDirectory, "key.bin")), encrypted.subarray(0, 12));
  decipher.setAAD(Buffer.from(`attachment:${child.id}:${id}`)); decipher.setAuthTag(encrypted.subarray(-16));
  assert.deepEqual(Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]), original);
  assert.equal(existsSync(originalPath), false);
});
