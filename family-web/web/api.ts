import type { Attachment, AuditEntry, Child, ChildInput, HealthRecord, Invite, RecordInput, RecordRevision, SessionInfo, Share, SharedSummary } from "../../server/src/shared/types";
import type { AgentGrant, AgentScope, MedicalSummary, ProfileRevision } from "../../server/src/shared/types";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
let csrfToken = "";
export function setCsrfToken(value: string) { csrfToken = value; }
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && typeof options.body === "string") headers.set("Content-Type", "application/json");
  if (options.method && !["GET", "HEAD"].includes(options.method)) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`/api/family${path}`, { ...options, headers, credentials: "same-origin" });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data && typeof data === "object" && "error" in data ? (data as { error: { code?: string; message?: string } }).error : undefined;
    throw new ApiError(response.status, error?.code ?? "HTTP_ERROR", error?.message ?? `请求失败（${response.status}），请稍后重试。`);
  }
  if (data === null) throw new ApiError(response.status, "INVALID_RESPONSE", "服务返回了无法读取的内容，请重试。");
  return data as T;
}
function json(method: string, data: unknown): RequestInit { return { method, body: JSON.stringify(data) }; }
const childPath = (id: string) => `/children/${encodeURIComponent(id)}`;
const recordPath = (childId: string, id: string) => `${childPath(childId)}/records/${encodeURIComponent(id)}`;
export const api = {
  setup: () => request<{ registrationOpen: boolean }>("/setup"),
  session: () => request<SessionInfo>("/session"),
  login: (username: string, password: string) => request<SessionInfo>("/login", json("POST", { username, password })),
  register: (data: { username: string; displayName: string; password: string; inviteCode?: string; consent: true }) => request<SessionInfo>("/register", json("POST", data)),
  logout: () => request<{ ok: true }>("/logout", json("POST", {})),
  children: () => request<{ children: Child[] }>("/children"),
  saveChild: (data: ChildInput, id?: string, expectedVersion?: number) => request<{ child: Child }>(id ? childPath(id) : "/children", json(id ? "PATCH" : "POST", id ? { ...data, expectedVersion } : data)),
  profileHistory: (id: string) => request<{ revisions: ProfileRevision[] }>(childPath(id) + "/profile-revisions"),
  deleteChild: (id: string, confirmation: string) => request<{ ok: true }>(childPath(id), json("DELETE", { confirmation })),
  records: (id: string, signal?: AbortSignal) => request<{ records: HealthRecord[] }>(`${childPath(id)}/records`, { signal }),
  saveRecord: (childId: string, data: RecordInput, original?: HealthRecord, reason?: string, idempotencyKey?: string) => request<{ record: HealthRecord }>(original ? recordPath(childId, original.id) : `${childPath(childId)}/records`, { ...json(original ? "PUT" : "POST", original ? { ...data, expectedVersion: original.version, reason } : data), headers: original ? {} : { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() } }),
  confirm: (childId: string, record: HealthRecord) => request<{ record: HealthRecord }>(`${recordPath(childId, record.id)}/confirm`, json("POST", { expectedVersion: record.version, attestation: true })),
  deleteRecord: (childId: string, record: HealthRecord) => request<{ ok: true }>(recordPath(childId, record.id), json("DELETE", { expectedVersion: record.version })),
  revisions: (childId: string, id: string) => request<{ revisions: RecordRevision[] }>(`${recordPath(childId, id)}/revisions`),
  attachments: (id: string, signal?: AbortSignal) => request<{ attachments: Attachment[] }>(`${childPath(id)}/attachments`, { signal }),
  upload: (id: string, file: File) => request<{ attachment: Attachment }>(`${childPath(id)}/attachments`, { method: "POST", body: file, headers: { "Content-Type": file.type, "X-Filename": encodeURIComponent(file.name) } }),
  deleteAttachment: (id: string, attachmentId: string) => request<{ ok: true }>(`${childPath(id)}/attachments/${encodeURIComponent(attachmentId)}`, json("DELETE", {})),
  attachmentUrl: (id: string, attachmentId: string) => `/api/family${childPath(id)}/attachments/${encodeURIComponent(attachmentId)}`,
  export: (id: string) => request<Record<string, unknown>>(`${childPath(id)}/export`),
  shares: (id: string, signal?: AbortSignal) => request<{ shares: Share[] }>(`${childPath(id)}/shares`, { signal }),
  createShare: (id: string, hours: 24 | 72 | 168) => request<{ share: Share }>(`${childPath(id)}/shares`, json("POST", { hours })),
  revokeShare: (id: string, shareId: string) => request<{ ok: true }>(`${childPath(id)}/shares/${encodeURIComponent(shareId)}`, json("DELETE", {})),
  shared: (token: string) => request<SharedSummary>(`/shared/${encodeURIComponent(token)}`),
  audit: () => request<{ entries: AuditEntry[] }>("/audit"),
  invite: () => request<Invite>("/invites", json("POST", {})),
  connectionInfo: () => request<{ endpoint: string }>("/connection-info"),
  familyAgentGrants: () => request<{ grants: AgentGrant[] }>("/agent-grants"),
  createFamilyAgentGrant: (data: { name: string; days: number; scopes: AgentScope[]; consent: true }) => request<{ grant: AgentGrant & { token: string } }>("/agent-grants", json("POST", data)),
  revokeFamilyAgentGrant: (id: string) => request<{ ok: true }>("/agent-grants/" + encodeURIComponent(id), json("DELETE", {})),
  agentGrants: (id: string) => request<{ grants: AgentGrant[] }>(childPath(id) + "/agent-grants"),
  createAgentGrant: (id: string, data: { name: string; days: number; scopes: AgentScope[]; consent: true }) => request<{ grant: AgentGrant & { token: string } }>(childPath(id) + "/agent-grants", json("POST", data)),
  revokeAgentGrant: (id: string, grantId: string) => request<{ ok: true }>(childPath(id) + "/agent-grants/" + encodeURIComponent(grantId), json("DELETE", {})),
  medicalSummary: (id: string) => request<{ summary: MedicalSummary; markdown: string }>(childPath(id) + "/medical-summary"),
};
export function message(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return `${error.message} 请重新载入当前记录，核对后再保存。`;
  if (error instanceof Error) return error.message;
  return "操作未完成，请检查连接后重试。";
}
