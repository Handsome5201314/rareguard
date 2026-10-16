import { z } from "zod";
import { agentScopes, clinicalSections, metricDefinitions, type MetricCode, type ClinicalSection } from "../shared/types.js";

const metricCodes = Object.keys(metricDefinitions) as [MetricCode, ...MetricCode[]];

export const registerSchema = z.object({
  username: z.string().min(3).max(40),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(200),
  inviteCode: z.string().min(1).max(200).optional(),
  consent: z.literal(true),
});

export const loginSchema = z.object({
  username: z.string().min(3).max(40),
  password: z.string().min(1).max(200),
});

export const childInputSchema = z.object({
  nickname: z.string().trim().min(1).max(120),
  birthYear: z.number().int().min(1900).max(2200).nullable(),
  diagnosis: z.string().trim().max(500),
  validationConsent: z.boolean(),
  relationship: z.enum(["self", "child"]).default("child"),
});

// Clinical validation consent can only be changed by the signed-in user on the web.
export const agentProfileSchema = childInputSchema.omit({ validationConsent: true }).required({ relationship: true }).strict();
export const agentProfilePatchSchema = agentProfileSchema.partial().strict().refine(input => Object.keys(input).length > 0, "至少提供一个需要修改的字段。");

export const measurementSchema = z.object({
  code: z.enum(metricCodes),
  value: z.string().min(1).max(200),
  unit: z.string().min(1).max(80),
});

export const recordInputSchema = z.object({
  kind: z.enum(["lab", "symptom", "medication", "visit"]),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  occurredTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable(),
  timezone: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(10000),
  source: z.string().trim().min(1).max(500),
  measurements: z.array(measurementSchema).max(100),
  attachmentIds: z.array(z.string().uuid()).max(100),
  clinical: z.object(Object.fromEntries(Object.keys(clinicalSections).map(key => [key, z.string().max(10000).optional()])) as Record<ClinicalSection, z.ZodOptional<z.ZodString>>).strict().optional(),
});

export const agentGrantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(["records:read", "drafts:write", "attachments:write"])).min(1).max(3),
  days: z.number().int().min(1).max(90),
  consent: z.literal(true),
}).strict();

export const familyAgentGrantSchema = agentGrantSchema.extend({
  scopes: z.array(z.enum(agentScopes)).min(1).max(agentScopes.length),
}).strict();

export const assessmentSchema = z.object({
  scaleId: z.string().min(1).max(120),
  assessmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  inputVersions: z.array(z.object({ id: z.string().uuid(), version: z.number().int().positive() })).max(100),
  result: z.unknown(),
});

export function isAsciiUsername(value: string): boolean {
  return /^[\x21-\x7e]{3,40}$/.test(value);
}
