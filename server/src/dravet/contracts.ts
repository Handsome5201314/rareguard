import { z } from "zod";

// Times always include an explicit offset. Unverified device clocks remain raw metadata.
export const instant = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)), "无效时间");
export const deviceInput = z.object({ name: z.string().trim().min(1).max(80), model: z.string().trim().min(1).max(80), protocol: z.string().trim().min(1).max(80), consent: z.literal(true) }).strict();
const base = { id: z.string().uuid(), sessionId: z.string().uuid(), sequence: z.number().int().nonnegative().safe(), sampledAt: instant, receivedAt: instant, timeSource: z.enum(["device_verified", "phone_received"]), rawTimestamp: z.string().max(100).nullable(), source: z.enum(["measured", "replay", "synthetic"]), quality: z.enum(["good", "poor", "unknown"]), hardwareId: z.string().regex(/^[a-f0-9]{64}$/).optional() };
const scalar = <K extends string, U extends string>(kind: K, unit: U, range?: { min?: number; max?: number }) => z.object({
  ...base, kind: z.literal(kind), value: z.number().finite().min(range?.min ?? Number.NEGATIVE_INFINITY).max(range?.max ?? Number.POSITIVE_INFINITY), unit: z.literal(unit),
}).strict();
export const sampleInput = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("hr"), value: z.number().finite().positive(), unit: z.literal("bpm") }).strict(),
  z.object({ ...base, kind: z.literal("spo2"), value: z.number().finite().min(0).max(100), unit: z.literal("%") }).strict(),
  z.object({ ...base, kind: z.literal("acc"), value: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict(), unit: z.enum(["raw", "g", "m/s2"]) }).strict(),
  scalar("bp_sys", "mmHg", { min: 0, max: 300 }),
  scalar("bp_dia", "mmHg", { min: 0, max: 300 }),
  scalar("bp_hr", "bpm", { min: 0, max: 300 }),
  scalar("temp", "°C", { min: -50, max: 100 }),
  scalar("glu", "mmol/L", { min: 0, max: 100 }),
  scalar("stress", "vendor_scalar", { min: 0, max: 1000 }),
  scalar("hrv", "vendor_scalar", { min: 0, max: 10000 }),
  scalar("pi", "vendor_pi", { min: 0, max: 100 }),
]);
export const batchInput = z.object({ batchId: z.string().uuid(), samples: z.array(sampleInput).min(1).max(500) }).strict();
export const eventInput = z.object({ id: z.string().uuid(), sessionId: z.string().uuid(), occurredAt: instant, kind: z.enum(["connected", "disconnected", "collection_error", "alarm_requested", "alarm_sounded", "caregiver_ack", "observation"]), source: z.enum(["measured", "replay", "synthetic"]), relatedEventId: z.string().uuid().nullable(), ruleVersion: z.string().max(80).nullable(), note: z.string().max(2000) }).strict();
export const windowInput = z.object({ from: instant, to: instant, limit: z.number().int().min(1).max(1000).default(500) }).strict().refine(v => Date.parse(v.to) > Date.parse(v.from) && Date.parse(v.to) - Date.parse(v.from) <= 7 * 86400000, "查询窗口应大于0且不超过7天");
export type Sample = z.infer<typeof sampleInput>;
export type MonitorEvent = z.infer<typeof eventInput>;
export type Window = z.infer<typeof windowInput>;
