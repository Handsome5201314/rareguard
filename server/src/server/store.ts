import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { metricDefinitions, type AssessmentRun, type Attachment, type AuditEntry, type Child, type ChildInput, type HealthRecord, type Invite, type RecordInput, type RecordRevision, type Share, type SharedSummary, type User } from "../shared/types.js";
import { assessmentSchema, childInputSchema, isAsciiUsername, loginSchema, recordInputSchema, registerSchema } from "./validation.js";
import { agentGrantSchema, familyAgentGrantSchema } from "./validation.js";
import type { AgentGrant, AgentIntake, AgentScope, ProfileRevision } from "../shared/types.js";

type Row = Record<string, SQLOutputValue>;
type SessionResult = { user: User; token: string; csrfToken: string };
type StoredAttachment = Attachment & { storagePath: string };
type RegisterInput = { username: string; displayName: string; password: string; inviteCode?: string; consent: true };
type AssessmentInput = Pick<AssessmentRun, "scaleId" | "assessmentDate" | "inputVersions" | "result">;

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const CONSENT_VERSION = "family-local-consent-v1";
const VALIDATION_CONSENT_VERSION = "family-internal-validation-v1";
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "AppError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function now(): string { return new Date().toISOString(); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** SQLite is the source of truth; clinical JSON is encrypted before it reaches SQLite. */
export class FamilyStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly dataDir: string;
  private transactionDepth = 0;

  constructor(dataDir: string) {
    const directory = resolve(dataDir);
    this.dataDir = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const databasePath = resolve(directory, "family.sqlite");
    const keyPath = resolve(directory, "key.bin");
    if (!existsSync(keyPath)) {
      if (existsSync(databasePath) && statSync(databasePath).size > 0) {
        throw new Error("存储密钥缺失：无法打开已有病程数据库。请恢复与数据库对应的 key.bin。");
      }
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error("存储密钥无效：key.bin 必须包含 32 字节密钥。");
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      this.migrate();
      const check = this.row("SELECT value FROM metadata WHERE key='encryption_check'");
      if (check) this.open<string>(String(check.value), "encryption-check");
      else this.run("INSERT INTO metadata(key,value) VALUES('encryption_check',?)", this.seal("family-store-v1", "encryption-check"));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    const version = Number(this.row("PRAGMA user_version")?.user_version ?? 0);
    if (version > 3) throw new Error("数据库版本比当前服务新，请使用对应版本的服务。");
    if (version === 3) return;
    if (version === 2) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE agent_grants_v3 (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), child_id TEXT REFERENCES children(id), name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT);
          INSERT INTO agent_grants_v3 SELECT * FROM agent_grants;
          DROP TABLE agent_grants;
          ALTER TABLE agent_grants_v3 RENAME TO agent_grants;
          CREATE INDEX agent_grants_owner ON agent_grants(owner_id,child_id);
          CREATE TABLE IF NOT EXISTS profile_revisions (child_id TEXT NOT NULL REFERENCES children(id), owner_id TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(child_id,version));
          CREATE TABLE IF NOT EXISTS agent_requests (grant_id TEXT NOT NULL REFERENCES agent_grants(id), request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, response_payload TEXT NOT NULL, PRIMARY KEY(grant_id,request_key));
        `);
        for (const row of this.rows("SELECT id,owner_id,payload FROM children")) {
          const original = this.open<Child>(String(row.payload), `child:${row.id}`);
          const profile: Child = { ...original, relationship: original.relationship ?? "child", version: original.version ?? 1, updatedAt: original.updatedAt ?? original.createdAt };
          this.run("UPDATE children SET payload=? WHERE id=?", this.seal(profile, `child:${row.id}`), String(row.id));
          if (!this.row("SELECT version FROM profile_revisions WHERE child_id=? AND version=?", profile.id, profile.version)) this.profileRevision(String(row.owner_id), profile, "web", "迁移已有档案；保留原资料");
        }
        this.db.exec("PRAGMA user_version=3;");
      });
      return;
    }
    if (version === 1) {
      this.db.exec("BEGIN IMMEDIATE; CREATE TABLE agent_grants (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), child_id TEXT NOT NULL REFERENCES children(id), name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT); CREATE INDEX agent_grants_owner ON agent_grants(owner_id,child_id); PRAGMA user_version=2; COMMIT;");
      this.migrate(); return;
    }
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','parent')),
        password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
        consent_version TEXT NOT NULL, consent_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE invites (
        code_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT REFERENCES users(id)
      );
      CREATE TABLE children (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), payload TEXT NOT NULL,
        created_at TEXT NOT NULL, deleted_at TEXT, validation_consent_version TEXT, validation_consent_at TEXT
      );
      CREATE INDEX children_owner ON children(owner_id, deleted_at);
      CREATE TABLE records (
        id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(id), owner_id TEXT NOT NULL REFERENCES users(id),
        version INTEGER NOT NULL, confirmation TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE INDEX records_child ON records(child_id, owner_id, deleted_at);
      CREATE TABLE revisions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL REFERENCES records(id),
        child_id TEXT NOT NULL REFERENCES children(id), owner_id TEXT NOT NULL REFERENCES users(id),
        version INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX revisions_record ON revisions(record_id, owner_id, sequence);
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(id), owner_id TEXT NOT NULL REFERENCES users(id),
        payload TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE INDEX attachments_child ON attachments(child_id, owner_id, deleted_at);
      CREATE TABLE idempotency (
        owner_id TEXT NOT NULL REFERENCES users(id), child_id TEXT NOT NULL REFERENCES children(id),
        request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, record_id TEXT NOT NULL REFERENCES records(id),
        response_payload TEXT NOT NULL, PRIMARY KEY(owner_id, child_id, request_key)
      );
      CREATE TABLE shares (
        id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(id), owner_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE INDEX shares_child ON shares(child_id, owner_id);
      CREATE TABLE assessments (
        id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(id), owner_id TEXT NOT NULL REFERENCES users(id),
        payload TEXT NOT NULL, created_at TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1))
      );
      CREATE INDEX assessments_child ON assessments(child_id, owner_id, created_at);
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL REFERENCES users(id),
        action TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX audit_owner ON audit(owner_id, id);
      CREATE TABLE agent_grants (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), child_id TEXT NOT NULL REFERENCES children(id), name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT);
      CREATE INDEX agent_grants_owner ON agent_grants(owner_id,child_id);
      PRAGMA user_version=2;
      COMMIT;
    `);
    this.migrate();
  }

  private row(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...values); }
  private rows(sql: string, ...values: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...values); }
  private run(sql: string, ...values: SQLInputValue[]): void { this.db.prepare(sql).run(...values); }
  private transaction<T>(operation: () => T): T {
    const savepoint = this.transactionDepth ? `family_tx_${this.transactionDepth}` : null;
    this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = operation();
      this.db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : "ROLLBACK");
      throw error;
    } finally { this.transactionDepth--; }
  }

  private seal(value: unknown, purpose: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  private open<T>(value: string, purpose: string): T {
    try {
      const [version, iv, tag, ciphertext] = value.split(".");
      if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid encrypted payload");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8")) as T;
    } catch {
      throw new Error("数据库内容无法解密或校验失败，请恢复匹配的数据库和密钥。");
    }
  }

  private validate<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    if (!result.success) throw new AppError(400, "INVALID_INPUT", "输入格式不正确，请核对必填项、长度和类型。");
    return result.data;
  }

  private auditAction(ownerId: string, action: string, objectType: string, objectId: string): void {
    this.run("INSERT INTO audit(owner_id,action,object_type,object_id,created_at) VALUES(?,?,?,?,?)", ownerId, action, objectType, objectId, now());
  }

  private requireUser(user: User): User {
    const row = this.row("SELECT id,username,display_name,role FROM users WHERE id=?", user?.id ?? "");
    if (!row) throw new AppError(401, "AUTH_REQUIRED", "请先登录。");
    return this.userFromRow(row);
  }

  private requireAdmin(user: User): User {
    const persisted = this.requireUser(user);
    if (persisted.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "此功能仅对本地管理员开放。");
    return persisted;
  }

  private userFromRow(row: Row): User {
    return { id: String(row.id), username: String(row.username), displayName: String(row.display_name), role: row.role as User["role"] };
  }

  setup(): { registrationOpen: boolean } {
    return { registrationOpen: Number(this.row("SELECT COUNT(*) AS count FROM users")?.count) === 0 };
  }

  register(input: RegisterInput): SessionResult {
    const validated = this.validate(registerSchema, input);
    if (!isAsciiUsername(validated.username)) throw new AppError(400, "INVALID_USERNAME", "用户名需为 3–40 个 ASCII 可见字符。");
    const username = validated.username.toLowerCase();
    const salt = randomBytes(16);
    const passwordHash = scryptSync(validated.password, salt, 64, scryptOptions).toString("hex");
    return this.transaction(() => {
      if (this.row("SELECT id FROM users WHERE username=?", username)) throw new AppError(409, "USERNAME_TAKEN", "该用户名已被使用。");
      const firstAccount = this.setup().registrationOpen;
      let invite: Row | undefined;
      if (!firstAccount) {
        if (validated.inviteCode) invite = this.row("SELECT * FROM invites WHERE code_hash=?", digest(validated.inviteCode));
        if (!invite || invite.used_at !== null || String(invite.expires_at) <= now()) throw new AppError(403, "INVITE_REQUIRED", "请使用有效且尚未使用的邀请码。");
      }
      const user: User = { id: randomUUID(), username, displayName: validated.displayName, role: firstAccount ? "admin" : "parent" };
      const timestamp = now();
      this.run("INSERT INTO users(id,username,display_name,role,password_salt,password_hash,consent_version,consent_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)", user.id, user.username, user.displayName, user.role, salt.toString("hex"), passwordHash, CONSENT_VERSION, timestamp, timestamp);
      if (invite) this.run("UPDATE invites SET used_at=?,used_by=? WHERE code_hash=? AND used_at IS NULL", timestamp, user.id, String(invite.code_hash));
      this.auditAction(user.id, "account.register", "user", user.id);
      return this.createSession(user);
    });
  }

  login(input: { username: string; password: string }): SessionResult {
    const user = this.verifyCredentials(input);
    return this.transaction(() => {
      this.auditAction(user.id, "account.login", "user", user.id);
      return this.createSession(user);
    });
  }

  private verifyCredentials(input: { username: string; password: string }): User {
    const validated = this.validate(loginSchema, input);
    const row = this.row("SELECT * FROM users WHERE username=?", validated.username.toLowerCase());
    const salt = row ? Buffer.from(String(row.password_salt), "hex") : Buffer.alloc(16);
    const candidate = scryptSync(validated.password, salt, 64, scryptOptions);
    const stored = row ? Buffer.from(String(row.password_hash), "hex") : Buffer.alloc(64);
    if (!row || stored.length !== candidate.length || !timingSafeEqual(candidate, stored)) throw new AppError(401, "INVALID_CREDENTIALS", "用户名或密码不正确。");
    return this.userFromRow(row);
  }

  private createSession(user: User): SessionResult {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const timestamp = now();
    this.run("DELETE FROM sessions WHERE expires_at<=?", timestamp);
    this.run("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)", digest(token), user.id, csrfToken, new Date(Date.parse(timestamp) + SESSION_MS).toISOString(), timestamp);
    return { user, token, csrfToken };
  }

  authenticate(token: string): { user: User; csrfToken: string } | null {
    if (!token || token.length > 512) return null;
    const row = this.row("SELECT u.id,u.username,u.display_name,u.role,s.csrf_token,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?", digest(token));
    if (!row) return null;
    if (String(row.expires_at) <= now()) {
      this.run("DELETE FROM sessions WHERE token_hash=?", digest(token));
      return null;
    }
    return { user: this.userFromRow(row), csrfToken: String(row.csrf_token) };
  }

  logout(token: string): void {
    const session = this.authenticate(token);
    if (!session) return;
    this.transaction(() => {
      this.run("DELETE FROM sessions WHERE token_hash=?", digest(token));
      this.auditAction(session.user.id, "account.logout", "user", session.user.id);
    });
  }

  createInvite(user: User): Invite {
    const admin = this.requireAdmin(user);
    const code = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
    this.transaction(() => {
      this.run("INSERT INTO invites(code_hash,created_by,expires_at) VALUES(?,?,?)", digest(code), admin.id, expiresAt);
      this.auditAction(admin.id, "invite.create", "invite", randomUUID());
    });
    return { code, expiresAt };
  }

  listChildren(user: User): Child[] {
    const owner = this.requireUser(user);
    return this.rows("SELECT id,payload FROM children WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at ASC", owner.id).map((row) => this.open<Child>(String(row.payload), `child:${row.id}`));
  }

  private childInput(input: ChildInput): ChildInput & { relationship: "self" | "child" } {
    const validated = childInputSchema.parse(input);
    if (validated.birthYear !== null && validated.birthYear > new Date().getUTCFullYear()) throw new AppError(400, "INVALID_BIRTH_YEAR", "出生年份不能晚于当前年份。");
    return validated;
  }

  createChild(user: User, input: ChildInput, intake?: AgentIntake): Child {
    const owner = this.requireUser(user);
    const validated = this.childInput(input);
    const timestamp = now();
    const child: Child = { ...validated, id: randomUUID(), version: 1, createdAt: timestamp, updatedAt: timestamp };
    return this.transaction(() => {
      this.run("INSERT INTO children(id,owner_id,payload,created_at,validation_consent_version,validation_consent_at) VALUES(?,?,?,?,?,?)", child.id, owner.id, this.seal(child, `child:${child.id}`), child.createdAt, child.validationConsent ? VALIDATION_CONSENT_VERSION : null, child.validationConsent ? child.createdAt : null);
      this.auditAction(owner.id, "child.create", "child", child.id);
      this.profileRevision(owner.id, child, intake ? "agent" : "web", "首次建档", intake);
      return child;
    });
  }

  assertChild(user: User, id: string): Child {
    const owner = this.requireUser(user);
    const row = this.row("SELECT payload FROM children WHERE id=? AND owner_id=? AND deleted_at IS NULL", id, owner.id);
    if (!row) throw new AppError(404, "CHILD_NOT_FOUND", "找不到该患者档案。");
    return this.open<Child>(String(row.payload), `child:${id}`);
  }

  updateChild(user: User, id: string, input: ChildInput, expectedVersion: number, reason = "网页修改档案", intake?: AgentIntake): Child {
    const validated = this.childInput(input);
    return this.transaction(() => {
      const current = this.assertChild(user, id);
      this.checkVersion(current, expectedVersion);
      const updated: Child = { ...validated, id, version: current.version + 1, createdAt: current.createdAt, updatedAt: now() };
      this.run("UPDATE children SET payload=?,validation_consent_version=?,validation_consent_at=? WHERE id=? AND owner_id=?", this.seal(updated, `child:${id}`), updated.validationConsent ? VALIDATION_CONSENT_VERSION : null, updated.validationConsent ? now() : null, id, user.id);
      if (current.validationConsent && !updated.validationConsent) this.invalidateAssessments(user.id, id);
      this.auditAction(user.id, "child.update", "child", id);
      this.profileRevision(user.id, updated, intake ? "agent" : "web", reason, intake);
      return updated;
    });
  }

  private profileRevision(ownerId: string, profile: Child, source: ProfileRevision["source"], reason: string, intake?: AgentIntake): void {
    const revision: ProfileRevision = { profile, source, reason, ...(intake ? { intake } : {}) };
    this.run("INSERT INTO profile_revisions(child_id,owner_id,version,payload) VALUES(?,?,?,?)", profile.id, ownerId, profile.version, this.seal(revision, `profile-revision:${profile.id}:${profile.version}`));
  }

  profileRevisions(user: User, childId: string): ProfileRevision[] {
    this.assertChild(user, childId);
    return this.rows("SELECT version,payload FROM profile_revisions WHERE child_id=? AND owner_id=? ORDER BY version", childId, user.id)
      .map(row => this.open<ProfileRevision>(String(row.payload), `profile-revision:${childId}:${row.version}`));
  }

  deleteChild(user: User, id: string, confirmation: string): void {
    this.transaction(() => {
      const child = this.assertChild(user, id);
      if (confirmation !== child.nickname) throw new AppError(400, "CONFIRMATION_MISMATCH", "请输入孩子代称确认删除。");
      const timestamp = now();
      this.run("UPDATE children SET deleted_at=? WHERE id=? AND owner_id=?", timestamp, id, user.id);
      this.run("UPDATE shares SET revoked_at=? WHERE child_id=? AND owner_id=? AND revoked_at IS NULL", timestamp, id, user.id);
      this.invalidateAssessments(user.id, id);
      this.auditAction(user.id, "child.delete", "child", id);
    });
  }

  private recordInput(input: RecordInput): RecordInput {
    const validated = this.validate(recordInputSchema, input) as RecordInput;
    if (!validDate(validated.occurredOn)) throw new AppError(400, "INVALID_DATE", "请选择有效的发生日期。");
    if (validated.occurredTime !== null) {
      const parts = validated.occurredTime.split(":").map(Number);
      if ((parts[0] ?? 24) > 23 || (parts[1] ?? 60) > 59 || (parts[2] ?? 0) > 59) throw new AppError(400, "INVALID_TIME", "发生时间格式不正确。");
    }
    try { new Intl.DateTimeFormat("en", { timeZone: validated.timezone }); }
    catch { throw new AppError(400, "INVALID_TIMEZONE", "请填写有效的 IANA 时区。"); }
    if (validated.kind === "lab" && validated.measurements.length === 0) throw new AppError(400, "MEASUREMENTS_REQUIRED", "检验记录至少需要一项指标。");
    const codes = new Set<string>();
    for (const measurement of validated.measurements) {
      if (!measurement.value.trim()) throw new AppError(400, "INVALID_MEASUREMENT", "指标原值不能为空。");
      if (!metricDefinitions[measurement.code].units.some((unit) => unit === measurement.unit)) throw new AppError(400, "INVALID_UNIT", "指标单位不受支持，请核对报告原单位。");
      if (codes.has(measurement.code)) throw new AppError(400, "DUPLICATE_MEASUREMENT", "同一记录中不能重复录入同一指标。");
      codes.add(measurement.code);
    }
    if (new Set(validated.attachmentIds).size !== validated.attachmentIds.length) throw new AppError(400, "DUPLICATE_ATTACHMENT", "不能重复关联同一附件。");
    return validated;
  }

  private assertAttachments(user: User, childId: string, ids: string[]): void {
    for (const id of ids) {
      if (!this.row("SELECT id FROM attachments WHERE id=? AND child_id=? AND owner_id=? AND deleted_at IS NULL", id, childId, user.id)) throw new AppError(404, "ATTACHMENT_NOT_FOUND", "找不到关联附件。");
    }
  }

  validateRecordDraft(input: RecordInput): RecordInput { return this.recordInput(input); }

  listRecords(user: User, childId: string): HealthRecord[] {
    this.assertChild(user, childId);
    return this.rows("SELECT id,payload FROM records WHERE child_id=? AND owner_id=? AND deleted_at IS NULL", childId, user.id)
      .map((row) => this.open<HealthRecord>(String(row.payload), `record:${row.id}`))
      .sort((a, b) => `${b.occurredOn}T${b.occurredTime ?? ""}`.localeCompare(`${a.occurredOn}T${a.occurredTime ?? ""}`) || b.createdAt.localeCompare(a.createdAt));
  }

  private assertRecord(user: User, childId: string, id: string, includeDeleted = false): HealthRecord {
    this.assertChild(user, childId);
    const row = this.row(`SELECT payload FROM records WHERE id=? AND child_id=? AND owner_id=?${includeDeleted ? "" : " AND deleted_at IS NULL"}`, id, childId, user.id);
    if (!row) throw new AppError(404, "RECORD_NOT_FOUND", "找不到该病程记录。");
    return this.open<HealthRecord>(String(row.payload), `record:${id}`);
  }

  private recordRevision(record: HealthRecord, changedBy: string, reason: string): void {
    const revision: RecordRevision = { ...record, changedBy, reason };
    this.run("INSERT INTO revisions(record_id,child_id,owner_id,version,payload) VALUES(?,?,?,?,?)", record.id, record.childId, changedBy, record.version, this.seal(revision, `revision:${record.id}:${record.version}`));
  }

  private checkVersion(record: { version: number }, expectedVersion: number): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new AppError(400, "INVALID_VERSION", "记录版本格式不正确。");
    if (record.version !== expectedVersion) throw new AppError(409, "VERSION_CONFLICT", "记录已经更新，请重新载入后核对。");
  }

  createRecord(user: User, childId: string, input: RecordInput, idempotencyKey: string, intake?: AgentIntake): HealthRecord {
    const validated = this.recordInput(input);
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200) throw new AppError(400, "IDEMPOTENCY_REQUIRED", "保存记录需要有效的请求标识。");
    return this.transaction(() => {
      this.assertChild(user, childId);
      const requestHash = createHmac("sha256", this.key).update(canonical(intake ? { validated, intake } : validated)).digest("hex");
      const previous = this.row("SELECT payload_hash,record_id,response_payload FROM idempotency WHERE owner_id=? AND child_id=? AND request_key=?", user.id, childId, idempotencyKey);
      if (previous) {
        if (String(previous.payload_hash) !== requestHash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该请求标识已用于不同的记录内容。");
        return this.open<HealthRecord>(String(previous.response_payload), `idempotency:${previous.record_id}`);
      }
      this.assertAttachments(user, childId, validated.attachmentIds);
      const timestamp = now();
      const record: HealthRecord = { ...validated, ...(intake ? { intake } : {}), id: randomUUID(), childId, version: 1, confirmation: "draft", confirmedAt: null, createdAt: timestamp, updatedAt: timestamp };
      this.run("INSERT INTO records(id,child_id,owner_id,version,confirmation,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", record.id, childId, user.id, record.version, record.confirmation, this.seal(record, `record:${record.id}`), timestamp, timestamp);
      this.recordRevision(record, user.id, "首次录入");
      this.invalidateAssessments(user.id, childId);
      this.run("INSERT INTO idempotency(owner_id,child_id,request_key,payload_hash,record_id,response_payload) VALUES(?,?,?,?,?,?)", user.id, childId, idempotencyKey, requestHash, record.id, this.seal(record, `idempotency:${record.id}`));
      this.auditAction(user.id, "record.create", "record", record.id);
      return record;
    });
  }

  private persistRecord(record: HealthRecord, ownerId: string): void {
    this.run("UPDATE records SET version=?,confirmation=?,payload=?,updated_at=? WHERE id=? AND child_id=? AND owner_id=? AND deleted_at IS NULL", record.version, record.confirmation, this.seal(record, `record:${record.id}`), record.updatedAt, record.id, record.childId, ownerId);
  }

  private grantFromRow(row: Row): AgentGrant {
    return { id: String(row.id), childId: row.child_id === null ? null : String(row.child_id), access: row.child_id === null ? "family" : "patient", name: String(row.name),
      scopes: JSON.parse(String(row.scopes)) as AgentScope[], createdAt: String(row.created_at),
      expiresAt: String(row.expires_at), revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
      lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at) };
  }

  createAgentGrant(user: User, childId: string, input: unknown): AgentGrant & { token: string } {
    const parsed = this.validate(agentGrantSchema, input);
    return this.transaction(() => {
      this.assertChild(user, childId);
      const token = "family_" + randomBytes(32).toString("base64url"), timestamp = now();
      const grant: AgentGrant = { id: randomUUID(), childId, access: "patient", name: parsed.name, scopes: [...new Set(parsed.scopes)],
        createdAt: timestamp, expiresAt: new Date(Date.now() + parsed.days * 86400000).toISOString(), revokedAt: null, lastUsedAt: null };
      this.run("INSERT INTO agent_grants(id,owner_id,child_id,name,token_hash,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        grant.id, user.id, childId, grant.name, digest(token), JSON.stringify(grant.scopes), timestamp, grant.expiresAt);
      this.auditAction(user.id, "agent.grant.create", "agent_grant", grant.id);
      return { ...grant, token };
    });
  }

  createFamilyAgentGrant(user: User, input: unknown): AgentGrant & { token: string } {
    const owner = this.requireUser(user), parsed = this.validate(familyAgentGrantSchema, input);
    if (parsed.scopes.includes("invites:write")) this.requireAdmin(owner);
    return this.transaction(() => this.insertFamilyGrant(owner, parsed.name, parsed.scopes, parsed.days * 86400000));
  }

  private insertFamilyGrant(user: User, name: string, scopes: AgentScope[], durationMs: number): AgentGrant & { token: string } {
    const token = "family_" + randomBytes(32).toString("base64url"), timestamp = now();
    const grant: AgentGrant = { id: randomUUID(), childId: null, access: "family", name, scopes: [...new Set(scopes)], createdAt: timestamp, expiresAt: new Date(Date.now() + durationMs).toISOString(), revokedAt: null, lastUsedAt: null };
    this.run("INSERT INTO agent_grants(id,owner_id,child_id,name,token_hash,scopes,created_at,expires_at) VALUES(?,?,NULL,?,?,?,?,?)", grant.id, user.id, grant.name, digest(token), JSON.stringify(grant.scopes), timestamp, grant.expiresAt);
    this.auditAction(user.id, "agent.family_grant.create", "agent_grant", grant.id);
    return { ...grant, token };
  }

  listFamilyAgentGrants(user: User): AgentGrant[] {
    const owner = this.requireUser(user);
    return this.rows("SELECT * FROM agent_grants WHERE owner_id=? AND child_id IS NULL ORDER BY created_at DESC", owner.id).map(row => this.grantFromRow(row));
  }

  revokeFamilyAgentGrant(user: User, id: string): void {
    const owner = this.requireUser(user);
    this.transaction(() => {
      if (!this.row("SELECT id FROM agent_grants WHERE id=? AND owner_id=? AND child_id IS NULL", id, owner.id)) throw new AppError(404, "GRANT_NOT_FOUND", "找不到该连接授权。");
      this.run("UPDATE agent_grants SET revoked_at=? WHERE id=? AND owner_id=? AND revoked_at IS NULL", now(), id, owner.id);
      this.auditAction(owner.id, "agent.family_grant.revoke", "agent_grant", id);
    });
  }

  listAgentGrants(user: User, childId: string): AgentGrant[] {
    this.assertChild(user, childId);
    return this.rows("SELECT * FROM agent_grants WHERE owner_id=? AND child_id=? ORDER BY created_at DESC", user.id, childId).map(row => this.grantFromRow(row));
  }

  revokeAgentGrant(user: User, childId: string, id: string): void {
    this.transaction(() => {
      this.assertChild(user, childId);
      if (!this.row("SELECT id FROM agent_grants WHERE id=? AND owner_id=? AND child_id=?", id, user.id, childId)) throw new AppError(404, "GRANT_NOT_FOUND", "找不到该连接授权。");
      this.run("UPDATE agent_grants SET revoked_at=? WHERE id=? AND owner_id=? AND revoked_at IS NULL", now(), id, user.id);
      this.auditAction(user.id, "agent.grant.revoke", "agent_grant", id);
    });
  }

  authenticateAgent(token: string, scope?: AgentScope): { user: User; grant: AgentGrant } {
    const row = this.row("SELECT * FROM agent_grants WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?", digest(token), now());
    if (!row) throw new AppError(401, "AGENT_UNAUTHORIZED", "连接凭据无效、已过期或已撤销。");
    const grant = this.grantFromRow(row);
    const userRow = this.row("SELECT id,username,display_name,role FROM users WHERE id=?", String(row.owner_id));
    if (!userRow) throw new AppError(401, "AGENT_UNAUTHORIZED", "连接授权已失效。");
    const user = this.userFromRow(userRow);
    if (grant.childId !== null) this.assertChild(user, grant.childId);
    if (scope && !grant.scopes.includes(scope)) throw new AppError(403, "AGENT_SCOPE", "连接未获此工具所需的权限。");
    this.run("UPDATE agent_grants SET last_used_at=? WHERE id=?", now(), grant.id);
    return { user, grant };
  }

  agentPatient(token: string, patientId?: string, scope?: AgentScope): { user: User; grant: AgentGrant; child: Child } {
    const auth = this.authenticateAgent(token, scope);
    if (auth.grant.childId !== null && patientId && patientId !== auth.grant.childId) throw new AppError(403, "AGENT_TARGET", "该连接只授权了一个患者，不能切换。");
    const id = patientId ?? auth.grant.childId;
    if (!id) throw new AppError(400, "PATIENT_REQUIRED", "请先列出档案，与用户确认本次患者，再提供 patientId；不能猜测当前患者。");
    return { ...auth, child: this.assertChild(auth.user, id) };
  }

  agentMutation<T>(token: string, scope: AgentScope, messageId: string, request: unknown, operation: (auth: { user: User; grant: AgentGrant }) => T): T {
    const auth = this.authenticateAgent(token, scope);
    z.string().trim().min(1).max(100).parse(messageId);
    const hash = createHmac("sha256", this.key).update(canonical({ scope, request })).digest("hex");
    const purpose = `agent-request:${auth.grant.id}:${messageId}`;
    return this.transaction(() => {
      const previous = this.row("SELECT payload_hash,response_payload FROM agent_requests WHERE grant_id=? AND request_key=?", auth.grant.id, messageId);
      if (previous) {
        if (String(previous.payload_hash) !== hash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "该消息标识已用于不同的操作；请重新核对。");
        return this.open<T>(String(previous.response_payload), purpose);
      }
      const result = operation(auth);
      this.run("INSERT INTO agent_requests(grant_id,request_key,payload_hash,response_payload) VALUES(?,?,?,?)", auth.grant.id, messageId, hash, this.seal(result, purpose));
      return result;
    });
  }

  createAgentDraft(token: string, input: RecordInput, messageId: string, channel: AgentIntake["channel"], sourceText: string, patientId?: string): HealthRecord {
    const { user, grant, child } = this.agentPatient(token, patientId, "drafts:write");
    z.string().trim().min(1).max(100).parse(messageId);
    z.enum(["web", "feishu", "wecom", "api", "octop"]).parse(channel);
    z.string().max(10000).parse(sourceText);
    const create = () => this.createRecord(user, child.id, input, "agent:" + grant.id + ":" + messageId, { grantId: grant.id, messageId, channel, sourceText });
    return grant.access === "family" ? this.agentMutation(token, "drafts:write", messageId, { tool: "create_record_draft", patientId: child.id, input, channel, sourceText }, create) : create();
  }

  updateAgentDraft(token: string, id: string, input: RecordInput, expectedVersion: number, reason: string, patientId?: string): HealthRecord {
    const { user, grant, child } = this.agentPatient(token, patientId, "drafts:write");
    const current = this.assertRecord(user, child.id, id);
    if (current.confirmation !== "draft" || current.intake?.grantId !== grant.id) throw new AppError(403, "AGENT_DRAFT_ONLY", "仅能修订该连接建立且尚未确认的草稿。");
    return this.updateRecord(user, child.id, id, input, expectedVersion, reason);
  }

  auditAgent(token: string, tool: string): void {
    const { user, grant } = this.authenticateAgent(token);
    this.auditAction(user.id, "agent.tool." + tool, "agent_grant", grant.id);
  }

  updateRecord(user: User, childId: string, id: string, input: RecordInput, expectedVersion: number, reason: string): HealthRecord {
    const validated = this.recordInput(input);
    if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) throw new AppError(400, "REVISION_REASON_REQUIRED", "请填写修改原因。");
    return this.transaction(() => {
      const current = this.assertRecord(user, childId, id);
      this.checkVersion(current, expectedVersion);
      this.assertAttachments(user, childId, validated.attachmentIds);
      const updated: HealthRecord = { ...validated, ...(current.intake ? { intake: current.intake } : {}), id, childId, version: current.version + 1, confirmation: "draft", confirmedAt: null, createdAt: current.createdAt, updatedAt: now() };
      this.persistRecord(updated, user.id);
      this.recordRevision(updated, user.id, reason.trim());
      this.invalidateAssessments(user.id, childId);
      this.auditAction(user.id, "record.update", "record", id);
      return updated;
    });
  }

  confirmRecord(user: User, childId: string, id: string, expectedVersion: number, intake?: AgentIntake): HealthRecord {
    return this.transaction(() => {
      const current = this.assertRecord(user, childId, id);
      this.checkVersion(current, expectedVersion);
      if (current.confirmation === "user_confirmed") return current;
      const timestamp = now();
      const confirmed: HealthRecord = { ...current, ...(intake ? { confirmationIntake: intake } : {}), confirmation: "user_confirmed", confirmedAt: timestamp, updatedAt: timestamp };
      this.persistRecord(confirmed, user.id);
      this.recordRevision(confirmed, user.id, intake ? "用户通过智能体明确核对确认；非模型自行确认" : "用户网页核对确认");
      this.invalidateAssessments(user.id, childId);
      this.auditAction(user.id, "record.confirm", "record", id);
      return confirmed;
    });
  }

  deleteRecord(user: User, childId: string, id: string, expectedVersion: number): void {
    this.transaction(() => {
      const current = this.assertRecord(user, childId, id);
      this.checkVersion(current, expectedVersion);
      this.run("UPDATE records SET deleted_at=? WHERE id=? AND child_id=? AND owner_id=?", now(), id, childId, user.id);
      this.recordRevision(current, user.id, "删除记录");
      this.invalidateAssessments(user.id, childId);
      this.auditAction(user.id, "record.delete", "record", id);
    });
  }

  revisions(user: User, childId: string, id: string): RecordRevision[] {
    this.assertRecord(user, childId, id, true);
    return this.rows("SELECT version,payload FROM revisions WHERE record_id=? AND child_id=? AND owner_id=? ORDER BY sequence ASC", id, childId, user.id)
      .map((row) => this.open<RecordRevision>(String(row.payload), `revision:${id}:${row.version}`));
  }

  addAttachment(user: User, childId: string, input: { id: string; filename: string; mime: string; size: number; storagePath: string }): Attachment {
    const validated = this.validate(z.object({ id: z.string().uuid(), filename: z.string().min(1).max(240), mime: z.enum(["application/pdf", "image/jpeg", "image/png"]), size: z.number().int().positive().max(8 * 1024 * 1024), storagePath: z.string().min(1).max(1000) }), input);
    const storagePath = this.relativeAttachmentPath(validated.storagePath);
    return this.transaction(() => {
      this.assertChild(user, childId);
      if (this.row("SELECT id FROM attachments WHERE id=?", validated.id)) throw new AppError(409, "ATTACHMENT_CONFLICT", "该附件标识已存在。");
      const attachment: StoredAttachment = { ...validated, storagePath, childId, createdAt: now() };
      this.run("INSERT INTO attachments(id,child_id,owner_id,payload,created_at) VALUES(?,?,?,?,?)", attachment.id, childId, user.id, this.seal(attachment, `attachment:${attachment.id}`), attachment.createdAt);
      this.auditAction(user.id, "attachment.create", "attachment", attachment.id);
      return this.publicAttachment(attachment);
    });
  }

  private publicAttachment(attachment: StoredAttachment): Attachment {
    const { storagePath: _storagePath, ...publicFields } = attachment;
    return publicFields;
  }

  private relativeAttachmentPath(storagePath: string): string {
    const absolute = resolve(this.dataDir, storagePath.replaceAll("\\", "/"));
    const relativePath = relative(this.dataDir, absolute);
    if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new AppError(400, "INVALID_ATTACHMENT_PATH", "附件路径必须位于本地资料目录内。");
    }
    return relativePath.replaceAll("\\", "/");
  }

  private absoluteAttachmentPath(storagePath: string): string {
    if (isAbsolute(storagePath) || win32.isAbsolute(storagePath)) {
      throw new AppError(500, "INVALID_STORED_ATTACHMENT_PATH", "附件元数据路径无效，请检查资料备份。");
    }
    return resolve(this.dataDir, this.relativeAttachmentPath(storagePath));
  }

  getAttachment(user: User, childId: string, id: string): StoredAttachment {
    this.assertChild(user, childId);
    const row = this.row("SELECT payload FROM attachments WHERE id=? AND child_id=? AND owner_id=? AND deleted_at IS NULL", id, childId, user.id);
    if (!row) throw new AppError(404, "ATTACHMENT_NOT_FOUND", "找不到该附件。");
    const attachment = this.open<StoredAttachment>(String(row.payload), `attachment:${id}`);
    return { ...attachment, storagePath: this.absoluteAttachmentPath(attachment.storagePath) };
  }

  listAttachments(user: User, childId: string): Attachment[] {
    this.assertChild(user, childId);
    return this.rows("SELECT id,payload FROM attachments WHERE child_id=? AND owner_id=? AND deleted_at IS NULL ORDER BY created_at DESC", childId, user.id).map((row) => this.publicAttachment(this.open<StoredAttachment>(String(row.payload), `attachment:${row.id}`)));
  }

  deleteAttachment(user: User, childId: string, id: string): { storagePath: string } {
    return this.transaction(() => {
      const attachment = this.getAttachment(user, childId, id);
      // A historical revision still relies on its source document, even after a later edit detaches it.
      const linked = this.rows("SELECT record_id,version,payload FROM revisions WHERE child_id=? AND owner_id=?", childId, user.id)
        .some((row) => this.open<RecordRevision>(String(row.payload), `revision:${row.record_id}:${row.version}`).attachmentIds.includes(id));
      if (linked) throw new AppError(409, "ATTACHMENT_IN_USE", "该附件已关联病程历史，无法单独删除。");
      this.run("UPDATE attachments SET deleted_at=? WHERE id=? AND child_id=? AND owner_id=?", now(), id, childId, user.id);
      this.auditAction(user.id, "attachment.delete", "attachment", id);
      return { storagePath: attachment.storagePath };
    });
  }

  exportChild(user: User, childId: string): { formatVersion: 1; child: Child; profileRevisions: ProfileRevision[]; records: HealthRecord[]; revisions: RecordRevision[]; attachments: Attachment[]; exportedAt: string } {
    const child = this.assertChild(user, childId);
    const revisions = this.rows("SELECT record_id,version,payload FROM revisions WHERE child_id=? AND owner_id=? ORDER BY sequence ASC", childId, user.id)
      .map((row) => this.open<RecordRevision>(String(row.payload), `revision:${row.record_id}:${row.version}`));
    this.auditAction(user.id, "child.export", "child", childId);
    return { formatVersion: 1, child, profileRevisions: this.profileRevisions(user, childId), records: this.listRecords(user, childId), revisions, attachments: this.listAttachments(user, childId), exportedAt: now() };
  }

  audit(user: User): AuditEntry[] {
    this.requireUser(user);
    return this.rows("SELECT id,action,object_type,object_id,created_at FROM audit WHERE owner_id=? ORDER BY id DESC", user.id).map((row) => ({ id: Number(row.id), action: String(row.action), objectType: String(row.object_type), objectId: String(row.object_id), createdAt: String(row.created_at) }));
  }

  private shareFromRow(row: Row): Share {
    return { id: String(row.id), childId: String(row.child_id), expiresAt: String(row.expires_at), createdAt: String(row.created_at), revokedAt: row.revoked_at === null ? null : String(row.revoked_at) };
  }

  listShares(user: User, childId: string): Share[] {
    this.assertChild(user, childId);
    return this.rows("SELECT * FROM shares WHERE child_id=? AND owner_id=? ORDER BY created_at DESC", childId, user.id).map((row) => this.shareFromRow(row));
  }

  createShare(user: User, childId: string, hours: number): Share & { token: string } {
    if (![24, 72, 168].includes(hours)) throw new AppError(400, "INVALID_SHARE_DURATION", "分享时长必须为 24、72 或 168 小时。");
    return this.transaction(() => {
      this.assertChild(user, childId);
      const share: Share = { id: randomUUID(), childId, expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(), createdAt: now(), revokedAt: null };
      const token = randomBytes(32).toString("base64url");
      this.run("INSERT INTO shares(id,child_id,owner_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)", share.id, childId, user.id, digest(token), share.expiresAt, share.createdAt);
      this.auditAction(user.id, "share.create", "share", share.id);
      return { ...share, token };
    });
  }

  revokeShare(user: User, childId: string, id: string): void {
    this.transaction(() => {
      this.assertChild(user, childId);
      const share = this.row("SELECT revoked_at FROM shares WHERE id=? AND child_id=? AND owner_id=?", id, childId, user.id);
      if (!share) throw new AppError(404, "SHARE_NOT_FOUND", "找不到该分享。");
      if (share.revoked_at !== null) return;
      this.run("UPDATE shares SET revoked_at=? WHERE id=? AND child_id=? AND owner_id=?", now(), id, childId, user.id);
      this.auditAction(user.id, "share.revoke", "share", id);
    });
  }

  sharedSummary(token: string): SharedSummary {
    if (typeof token !== "string" || token.length > 512) throw new AppError(404, "SHARE_NOT_FOUND", "分享已失效或不存在。");
    const share = this.row("SELECT s.*,c.payload AS child_payload FROM shares s JOIN children c ON c.id=s.child_id AND c.owner_id=s.owner_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND c.deleted_at IS NULL", digest(token), now());
    if (!share) throw new AppError(404, "SHARE_NOT_FOUND", "分享已失效或不存在。");
    const child = this.open<Child>(String(share.child_payload), `child:${share.child_id}`);
    const records = this.rows("SELECT id,payload FROM records WHERE child_id=? AND owner_id=? AND deleted_at IS NULL AND confirmation='user_confirmed'", String(share.child_id), String(share.owner_id))
      .map((row) => this.open<HealthRecord>(String(row.payload), `record:${row.id}`))
      .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || (b.occurredTime ?? "").localeCompare(a.occurredTime ?? ""))
      .map(({ id, kind, occurredOn, occurredTime, timezone, title, notes, measurements, confirmation }) => ({ id, kind, occurredOn, occurredTime, timezone, title, notes, measurements, confirmation }));
    return { child: { nickname: child.nickname, diagnosis: child.diagnosis }, records, expiresAt: String(share.expires_at) };
  }

  private assertAssessmentAccess(user: User, childId: string): Child {
    const child = this.assertChild(user, childId);
    this.requireAdmin(user);
    if (!child.validationConsent) throw new AppError(403, "VALIDATION_CONSENT_REQUIRED", "需先明确同意内部规则验证。");
    return child;
  }

  getSelectedRecords(user: User, childId: string, recordIds: string[], date: string): HealthRecord[] {
    this.assertAssessmentAccess(user, childId);
    if (!validDate(date)) throw new AppError(400, "INVALID_ASSESSMENT_DATE", "请选择有效的评估日期。");
    if (!Array.isArray(recordIds) || recordIds.length > 100 || recordIds.some((id) => typeof id !== "string") || new Set(recordIds).size !== recordIds.length) throw new AppError(400, "INVALID_RECORD_SELECTION", "所选记录无效或重复。");
    return recordIds.map((id) => {
      const record = this.assertRecord(user, childId, id);
      if (record.confirmation !== "user_confirmed") throw new AppError(409, "RECORD_NOT_CONFIRMED", "内部验证只能使用当前已确认记录。");
      if (record.occurredOn !== date) throw new AppError(400, "ASSESSMENT_DATE_MISMATCH", "所选记录必须发生于同一评估日期。");
      return record;
    });
  }

  saveAssessment(user: User, childId: string, input: AssessmentInput): AssessmentRun {
    const validated = this.validate(assessmentSchema, input) as AssessmentInput;
    if (validated.result === undefined) throw new AppError(400, "ASSESSMENT_RESULT_REQUIRED", "内部验证结果不能为空。");
    return this.transaction(() => {
      this.assertAssessmentAccess(user, childId);
      const records = this.getSelectedRecords(user, childId, validated.inputVersions.map(({ id }) => id), validated.assessmentDate);
      records.forEach((record, index) => this.checkVersion(record, validated.inputVersions[index]!.version));
      const assessment: AssessmentRun = { ...validated, id: randomUUID(), childId, createdAt: now(), stale: false };
      this.run("INSERT INTO assessments(id,child_id,owner_id,payload,created_at) VALUES(?,?,?,?,?)", assessment.id, childId, user.id, this.seal(assessment, `assessment:${assessment.id}`), assessment.createdAt);
      this.auditAction(user.id, "assessment.create", "assessment", assessment.id);
      return assessment;
    });
  }

  listAssessments(user: User, childId: string): AssessmentRun[] {
    this.assertAssessmentAccess(user, childId);
    return this.rows("SELECT id,payload,stale FROM assessments WHERE child_id=? AND owner_id=? ORDER BY created_at DESC", childId, user.id).map((row) => ({ ...this.open<AssessmentRun>(String(row.payload), `assessment:${row.id}`), stale: Number(row.stale) === 1 }));
  }

  private invalidateAssessments(ownerId: string, childId: string): void {
    // Every result is a dated snapshot. Later material can change its context even if it was not selected before.
    this.run("UPDATE assessments SET stale=1 WHERE child_id=? AND owner_id=?", childId, ownerId);
  }
}
