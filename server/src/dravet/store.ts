import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import type { User } from "../shared/types.js";
import { AppError, type FamilyStore } from "../server/store.js";
import { batchInput, deviceInput, eventInput, windowInput, type Sample, type MonitorEvent } from "./contracts.js";

type Row = Record<string, SQLOutputValue>;
type Principal = { user: User; patientId: string; deviceId: string | null };
type ReadResult<K extends "samples" | "events"> = Record<K, Array<{ deviceId: string } & (K extends "samples" ? Sample : MonitorEvent)>> & { truncated: boolean; window: { from: string; to: string }; notice: string };
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** Separate encrypted monitoring database; FamilyStore alone owns identity and profiles. */
export class DravetStore {
  private db: DatabaseSync;
  private key: Buffer;
  constructor(readonly family: FamilyStore, directory: string, private clock = Date.now) {
    const root = resolve(directory); mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = resolve(root, "dravet.sqlite"), keyPath = resolve(root, "key.bin");
    if (!existsSync(keyPath)) {
      if (existsSync(path) && statSync(path).size > 0) throw new Error("Dravet密钥缺失，请恢复完整监测目录。");
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error("Dravet密钥长度无效。");
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      const version = Number(this.row("PRAGMA user_version")!.user_version);
      if (version > 1) throw new Error("Dravet数据库版本高于当前程序，拒绝降级打开。");
      if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE devices(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,patient_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT);
        CREATE INDEX devices_patient ON devices(owner_id,patient_id);
        CREATE TABLE pairings(hash TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),payload TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE grants(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,owner_id TEXT NOT NULL,patient_id TEXT NOT NULL,device_id TEXT REFERENCES devices(id),kind TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL,revoked_at TEXT);
        CREATE TABLE batches(device_id TEXT NOT NULL REFERENCES devices(id),id TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(device_id,id));
        CREATE TABLE samples(device_id TEXT NOT NULL REFERENCES devices(id),id TEXT NOT NULL,session_id TEXT NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,quality TEXT NOT NULL,sampled_at INTEGER NOT NULL,received_at INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(device_id,id),UNIQUE(device_id,session_id,sequence,kind));
        CREATE INDEX samples_time ON samples(device_id,sampled_at,id);
        CREATE TABLE events(device_id TEXT NOT NULL REFERENCES devices(id),id TEXT NOT NULL,occurred_at INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(device_id,id));
        CREATE INDEX events_time ON events(device_id,occurred_at,id);
        CREATE TABLE audit(id INTEGER PRIMARY KEY,owner_id TEXT NOT NULL,action TEXT NOT NULL,object_id TEXT NOT NULL,created_at TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      const check = this.row("SELECT value FROM metadata WHERE key='key_check'");
      if (check) this.open(String(check.value), "key-check");
      else this.run("INSERT INTO metadata VALUES('key_check',?)", this.seal("dravet-v1", "key-check"));
    } catch (e) { this.db.close(); throw e; }
  }
  close() { this.db.close(); }
  private now() { return new Date(this.clock()).toISOString(); }
  private row(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).get(...args); }
  private rows(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).all(...args); }
  private run(sql: string, ...args: SQLInputValue[]) { this.db.prepare(sql).run(...args); }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  private seal(value: unknown, purpose: string) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
  }
  private open<T>(value: string, purpose: string): T {
    const data = Buffer.from(value, "base64"), cipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(purpose)); cipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString()) as T;
  }
  private audit(user: User, action: string, id: string) { this.run("INSERT INTO audit(owner_id,action,object_id,created_at) VALUES(?,?,?,?)", user.id, action, id, this.now()); }
  private access(p: Principal) { this.family.assertChild(p.user, p.patientId); return p; }
  private device(row: Row) { return { id: String(row.id), ...this.open<{ name: string; model: string; protocol: string }>(String(row.payload), `device:${row.id}`), createdAt: String(row.created_at), revokedAt: row.revoked_at as string | null }; }
  devices(user: User, patientId: string) {
    this.access({ user, patientId, deviceId: null });
    return this.rows("SELECT * FROM devices WHERE owner_id=? AND patient_id=? ORDER BY created_at,id", user.id, patientId).map(row => this.device(row));
  }
  pair(user: User, patientId: string, raw: unknown) {
    this.access({ user, patientId, deviceId: null }); const input = deviceInput.parse(raw);
    const id = randomUUID(), code = "dp_" + randomBytes(32).toString("base64url"), expires = this.clock() + 5 * 60000;
    return this.tx(() => {
      this.run("INSERT INTO devices(id,owner_id,patient_id,payload,created_at) VALUES(?,?,?,?,?)", id, user.id, patientId, this.seal({ name: input.name, model: input.model, protocol: input.protocol }, `device:${id}`), this.now());
      this.run("INSERT INTO pairings(hash,device_id,payload,expires) VALUES(?,?,?,?)", hash(code), id, this.seal({ user, patientId, deviceId: id }, `pair:${id}`), expires);
      this.audit(user, "device.pair.create", id);
      return { deviceId: id, pairingCode: code, expiresAt: new Date(expires).toISOString() };
    });
  }
  redeem(code: string) {
    if (!/^dp_[A-Za-z0-9_-]{43}$/.test(code)) throw new AppError(401, "PAIRING_INVALID", "配对包无效或已使用，请重新生成。");
    return this.tx(() => {
      const row = this.row("SELECT p.* FROM pairings p JOIN devices d ON d.id=p.device_id WHERE p.hash=? AND p.used=0 AND p.expires>? AND d.revoked_at IS NULL", hash(code), this.clock());
      if (!row) throw new AppError(401, "PAIRING_INVALID", "配对包已使用、撤销或过期，请重新生成。");
      const p = this.access(this.open<Principal>(String(row.payload), `pair:${row.device_id}`));
      this.run("UPDATE grants SET revoked_at=? WHERE device_id=? AND kind='device' AND revoked_at IS NULL", this.now(), p.deviceId);
      const grant = this.issue(p, "device", "APP上传凭据", 30);
      this.run("UPDATE pairings SET used=1 WHERE hash=?", hash(code)); this.audit(p.user, "device.pair.redeem", p.deviceId!);
      return { deviceId: p.deviceId, patientId: p.patientId, token: grant.token, expiresAt: grant.expiresAt };
    });
  }
  renew(user: User, patientId: string, deviceId: string) {
    this.access({ user, patientId, deviceId });
    return this.tx(() => {
      if (!this.row("SELECT id FROM devices WHERE id=? AND owner_id=? AND patient_id=? AND revoked_at IS NULL", deviceId, user.id, patientId)) throw new AppError(404, "NOT_FOUND", "设备不存在或已撤销，不能续期。");
      const code = "dp_" + randomBytes(32).toString("base64url"), expires = this.clock() + 300000;
      this.run("UPDATE pairings SET used=1 WHERE device_id=?", deviceId);
      this.run("INSERT INTO pairings(hash,device_id,payload,expires) VALUES(?,?,?,?)", hash(code), deviceId, this.seal({ user, patientId, deviceId }, `pair:${deviceId}`), expires);
      this.audit(user, "device.pair.renew", deviceId);
      return { deviceId, pairingCode: code, expiresAt: new Date(expires).toISOString() };
    });
  }
  private issue(p: Principal, kind: "device" | "agent", name: string, days: number) {
    const id = randomUUID(), token = (kind === "device" ? "dd_" : "da_") + randomBytes(32).toString("base64url"), expires = this.clock() + days * 86400000;
    const info = { id, name, createdAt: this.now(), expiresAt: new Date(expires).toISOString(), scopes: kind === "device" ? ["monitoring:upload"] : ["monitoring:read"] };
    this.run("INSERT INTO grants(id,hash,owner_id,patient_id,device_id,kind,payload,expires) VALUES(?,?,?,?,?,?,?,?)", id, hash(token), p.user.id, p.patientId, p.deviceId, kind, this.seal({ ...p, info }, `grant:${id}`), expires);
    return { ...info, token };
  }
  grant(user: User, patientId: string, name: string, days: number) {
    this.access({ user, patientId, deviceId: null });
    name = z.string().trim().min(1).max(80).parse(name);
    days = z.number().int().min(1).max(30).parse(days);
    return this.tx(() => { const grant = this.issue({ user, patientId, deviceId: null }, "agent", name, days); this.audit(user, "agent.grant.create", grant.id); return grant; });
  }
  grants(user: User, patientId: string) {
    this.access({ user, patientId, deviceId: null });
    return this.rows("SELECT * FROM grants WHERE owner_id=? AND patient_id=? AND kind='agent' ORDER BY id", user.id, patientId).map(row => ({ ...this.open<{info: object}>(String(row.payload), `grant:${row.id}`).info, revokedAt: row.revoked_at }));
  }
  revoke(user: User, patientId: string, id: string, kind: "device" | "agent") {
    this.access({ user, patientId, deviceId: null });
    this.tx(() => {
      const row = kind === "device" ? this.row("SELECT id FROM devices WHERE id=? AND owner_id=? AND patient_id=?", id, user.id, patientId) : this.row("SELECT id FROM grants WHERE id=? AND owner_id=? AND patient_id=? AND kind='agent'", id, user.id, patientId);
      if (!row) throw new AppError(404, "NOT_FOUND", "找不到授权对象。");
      if (kind === "device") { this.run("UPDATE devices SET revoked_at=? WHERE id=?", this.now(), id); this.run("UPDATE grants SET revoked_at=? WHERE device_id=?", this.now(), id); }
      else this.run("UPDATE grants SET revoked_at=? WHERE id=?", this.now(), id);
      this.audit(user, `${kind}.revoke`, id);
    });
  }
  authenticate(token: string, kind: "device" | "agent") {
    const pattern = kind === "device" ? /^dd_[A-Za-z0-9_-]{43}$/ : /^da_[A-Za-z0-9_-]{43}$/;
    if (!pattern.test(token)) throw new AppError(401, "DRAVET_UNAUTHORIZED", "监测凭据无效、过期或已撤销。");
    const row = this.row("SELECT * FROM grants WHERE hash=? AND kind=? AND revoked_at IS NULL AND expires>?", hash(token), kind, this.clock());
    if (!row) throw new AppError(401, "DRAVET_UNAUTHORIZED", "监测凭据无效、过期或已撤销。");
    const p = this.access(this.open<Principal & { info: { id: string; scopes: string[]; expiresAt: string } }>(String(row.payload), `grant:${row.id}`));
    if (p.deviceId && !this.row("SELECT id FROM devices WHERE id=? AND revoked_at IS NULL", p.deviceId)) throw new AppError(401, "DRAVET_UNAUTHORIZED", "设备已撤销。");
    return p as Principal & { info: { id: string; scopes: string[]; expiresAt: string } };
  }
  connection(token: string) {
    const p = this.authenticate(token, "agent"), child = this.family.assertChild(p.user, p.patientId);
    this.audit(p.user, "agent.read", p.info.id);
    return { account: { id: p.user.id }, grantId: p.info.id, patient: { id: child.id, nickname: child.nickname }, scopes: p.info.scopes, expiresAt: p.info.expiresAt };
  }
  ingest(token: string, raw: unknown) {
    const p = this.authenticate(token, "device"), input = batchInput.parse(raw), digest = hash(canonical(input));
    return this.tx(() => {
      const old = this.row("SELECT * FROM batches WHERE device_id=? AND id=?", p.deviceId, input.batchId);
      if (old) { if (old.hash !== digest) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "相同批次ID的内容不一致。"); return this.open(String(old.payload), `batch:${p.deviceId}:${input.batchId}`); }
      let inserted = 0;
      for (const sample of input.samples) {
        if (Date.parse(sample.sampledAt) > this.clock() + 300000 || Date.parse(sample.receivedAt) > this.clock() + 300000) throw new AppError(400, "CLOCK_AHEAD", "时间超过服务时钟五分钟，请检查手机和设备时钟。");
        const d = hash(canonical(sample)), existing = this.row("SELECT hash FROM samples WHERE device_id=? AND (id=? OR (session_id=? AND sequence=? AND kind=?))", p.deviceId, sample.id, sample.sessionId, sample.sequence, sample.kind);
        if (existing) { if (existing.hash !== d) throw new AppError(409, "SAMPLE_CONFLICT", "相同样本ID或序号的内容不一致。"); continue; }
        this.run("INSERT INTO samples VALUES(?,?,?,?,?,?,?,?,?,?,?)", p.deviceId, sample.id, sample.sessionId, sample.sequence, sample.kind, sample.source, sample.quality, Date.parse(sample.sampledAt), Date.parse(sample.receivedAt), d, this.seal(sample, `sample:${p.deviceId}:${sample.id}`)); inserted++;
      }
      const result = { batchId: input.batchId, received: input.samples.length, inserted, duplicates: input.samples.length - inserted, committedAt: this.now() };
      this.run("INSERT INTO batches VALUES(?,?,?,?)", p.deviceId, input.batchId, digest, this.seal(result, `batch:${p.deviceId}:${input.batchId}`));
      return result;
    });
  }
  event(token: string, raw: unknown) {
    const p = this.authenticate(token, "device"), input = eventInput.parse(raw), d = hash(canonical(input));
    if (Date.parse(input.occurredAt) > this.clock() + 300000) throw new AppError(400, "CLOCK_AHEAD", "事件时间超过服务时钟五分钟。");
    return this.tx(() => {
      const existing = this.row("SELECT hash FROM events WHERE device_id=? AND id=?", p.deviceId, input.id);
      if (existing) { if (existing.hash !== d) throw new AppError(409, "EVENT_CONFLICT", "事件ID的内容不一致。"); return { id: input.id, stored: true, duplicate: true }; }
      if (["alarm_sounded", "caregiver_ack"].includes(input.kind)) {
        const parent = input.relatedEventId && this.row("SELECT payload FROM events WHERE device_id=? AND id=?", p.deviceId, input.relatedEventId);
        const original = parent ? this.open<{kind: string; sessionId: string; source: string}>(String(parent.payload), `event:${p.deviceId}:${input.relatedEventId}`) : null;
        if (!original || original.kind !== "alarm_requested" || original.sessionId !== input.sessionId || original.source !== input.source) throw new AppError(409, "ALARM_REFERENCE", "响铃与确认必须关联同设备同会话的原始提醒事件。");
      }
      this.run("INSERT INTO events VALUES(?,?,?,?,?)", p.deviceId, input.id, Date.parse(input.occurredAt), d, this.seal(input, `event:${p.deviceId}:${input.id}`));
      this.audit(p.user, `event.${input.kind}`, input.id); return { id: input.id, stored: true, duplicate: false };
    });
  }
  read<K extends "samples" | "events">(user: User, patientId: string, kind: K, raw: unknown): ReadResult<K> {
    this.access({ user, patientId, deviceId: null }); const w = windowInput.parse(raw), column = kind === "samples" ? "sampled_at" : "occurred_at";
    const rows = this.rows(`SELECT r.* FROM ${kind} r JOIN devices d ON d.id=r.device_id WHERE d.owner_id=? AND d.patient_id=? AND r.${column}>=? AND r.${column}<? ORDER BY r.${column},r.device_id,r.id LIMIT ?`, user.id, patientId, Date.parse(w.from), Date.parse(w.to), w.limit + 1);
    return { [kind]: rows.slice(0, w.limit).map(row => ({ deviceId: String(row.device_id), ...this.open<object>(String(row.payload), `${kind === "samples" ? "sample" : "event"}:${row.device_id}:${row.id}`) })), truncated: rows.length > w.limit, window: { from: w.from, to: w.to }, notice: "最多返回limit条，truncated为true时缩小时间窗；来源及时间质量以每条记录为准。" } as ReadResult<K>;
  }
  summary(user: User, patientId: string, raw: unknown) {
    this.access({ user, patientId, deviceId: null }); const w = windowInput.parse(raw);
    const groups = this.rows(`WITH points AS (SELECT s.*,LAG(sampled_at) OVER(PARTITION BY s.device_id,session_id,kind,source ORDER BY sampled_at,s.id) AS previous FROM samples s JOIN devices d ON d.id=s.device_id WHERE d.owner_id=? AND d.patient_id=? AND sampled_at>=? AND sampled_at<?) SELECT device_id,kind,source,COUNT(*) AS count,MIN(sampled_at) AS first,MAX(sampled_at) AS last,MAX(sampled_at-previous) AS largest_gap_ms,SUM(quality='unknown') AS unknown_quality,SUM(quality='poor') AS poor_quality FROM points GROUP BY device_id,kind,source`, user.id, patientId, Date.parse(w.from), Date.parse(w.to));
    return { patientId, window: { from: w.from, to: w.to }, generatedAt: this.now(), groups, events: this.read(user, patientId, "events", w), notice: "仅描述收到的记录；间隔按设备、采集会话、信号与来源分组，不代表连续覆盖率。没有记录不等于正常。原始加速度未标定时只保留raw单位；设备上报提醒、响铃、家长确认分开记录，不等于临床确认。" };
  }
}
