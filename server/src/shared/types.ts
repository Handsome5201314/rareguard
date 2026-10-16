export const metricDefinitions = {
  ferritin: { label: "铁蛋白", units: ["ng/mL", "ug/L", "μg/L"] },
  platelets: { label: "血小板", units: ["10^9/L", "10^3/uL"] },
  ast: { label: "AST", units: ["U/L"] },
  triglycerides: { label: "甘油三酯", units: ["mmol/L", "mg/dL"] },
  fibrinogen: { label: "纤维蛋白原", units: ["g/L", "mg/dL", "mg/L"] },
  ldh: { label: "乳酸脱氢酶", units: ["U/L"] },
  hemoglobin: { label: "血红蛋白", units: ["g/L", "g/dL"] },
  absoluteNeutrophils: { label: "中性粒细胞绝对计数", units: ["10^9/L", "10^3/uL"] },
  solubleCd25: { label: "可溶性 CD25", units: ["U/mL"] },
  temperature: { label: "体温", units: ["°C"] },
  crp: { label: "C 反应蛋白", units: ["mg/L"] },
  esr: { label: "血沉", units: ["mm/h"] },
} as const;
export type MetricCode = keyof typeof metricDefinitions;
export type RecordKind = "lab" | "symptom" | "medication" | "visit";
export type Confirmation = "draft" | "user_confirmed";
export type User = { id: string; username: string; displayName: string; role: "admin" | "parent" };
export type SessionInfo = { user: User; csrfToken: string };
// Keep the existing child IDs and routes; a profile can now represent self or a child.
export type ChildInput = { nickname: string; birthYear: number | null; diagnosis: string; validationConsent: boolean; relationship?: "self" | "child" };
export type Child = ChildInput & { id: string; relationship: "self" | "child"; version: number; createdAt: string; updatedAt: string };
export type ProfileRevision = { profile: Child; source: "web" | "agent"; reason: string; intake?: AgentIntake };
export type Measurement = { code: MetricCode; value: string; unit: string };
export type RecordInput = {
  kind: RecordKind;
  occurredOn: string;
  occurredTime: string | null;
  timezone: string;
  title: string;
  notes: string;
  source: string;
  measurements: Measurement[];
  attachmentIds: string[];
  clinical?: Partial<Record<ClinicalSection, string>>;
};
export const clinicalSections = {
  chiefComplaint: "主诉", presentIllness: "现病史", pastHistory: "既往史",
  allergyHistory: "过敏史", personalHistory: "个人史／生长发育史", familyHistory: "家族史",
  physicalExamination: "体格检查（原记录）", auxiliaryExamination: "辅助检查",
  documentedDiagnosis: "已有诊断（原记录）", treatmentPlan: "诊疗意见／医嘱（原记录）",
} as const;
export type ClinicalSection = keyof typeof clinicalSections;
export const agentScopes = ["profiles:read", "profiles:write", "profiles:delete", "records:read", "drafts:write", "records:manage", "attachments:read", "attachments:write", "attachments:delete", "shares:manage", "exports:read", "audit:read", "invites:write", "validation:consent"] as const;
export type AgentScope = typeof agentScopes[number];
export type AgentGrant = {
  id: string; name: string; childId: string | null; access: "patient" | "family"; scopes: AgentScope[];
  createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null;
};
export type AgentIntake = { grantId: string; channel: "web" | "feishu" | "wecom" | "api" | "octop"; messageId: string; sourceText: string };
export type MedicalSummary = {
  format: string; title: string; generatedAt: string;
  child: { nickname: string; birthYear: number | null; diagnosis: string };
  notice: string; excludedDrafts: number;
  sections: { key: string; label: string; entries: { text: string; recordId: string; version: number; occurredOn: string; source: string; attachmentIds: string[] }[] }[];
  timeline: { recordId: string; version: number; kind: RecordKind; occurredOn: string; occurredTime: string | null; timezone: string; title: string; notes: string; source: string; attachmentIds: string[]; measurements: (Measurement & { label: string })[] }[];
};
export type HealthRecord = RecordInput & {
  id: string; childId: string; version: number; confirmation: Confirmation;
  confirmedAt: string | null; createdAt: string; updatedAt: string;
  intake?: AgentIntake;
  confirmationIntake?: AgentIntake;
};
export type RecordRevision = HealthRecord & { changedBy: string; reason: string };
export type Attachment = { id: string; childId: string; filename: string; mime: string; size: number; createdAt: string };
export type AuditEntry = { id: number; action: string; objectType: string; objectId: string; createdAt: string };
export type Invite = { code: string; expiresAt: string };
export type Share = { id: string; childId: string; expiresAt: string; createdAt: string; revokedAt: string | null; url?: string };
export type PublicRecord = Pick<HealthRecord, "id" | "kind" | "occurredOn" | "occurredTime" | "timezone" | "title" | "notes" | "measurements" | "confirmation">;
export type SharedSummary = { child: { nickname: string; diagnosis: string }; records: PublicRecord[]; expiresAt: string };
export type AssessmentRun = { id: string; childId: string; scaleId: string; assessmentDate: string; inputVersions: { id: string; version: number }[]; result: unknown; createdAt: string; stale: boolean };
