import { z } from "zod";
import { Decimal } from "decimal.js";

export const scaleIds = ["mas_2016", "ms_2019", "hlh_2004"] as const;
export type ScaleId = typeof scaleIds[number];

function validDate(value: string): boolean {
  const date = value.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDate, "无效日历日期");
const timeSchema = z.union([
  dateSchema,
  z.string().datetime({ offset: true }).refine(validDate, "无效日历日期"),
]).describe("采样/观察日期；YYYY-MM-DD，或带Z/时区偏移的ISO时间。精度按原输入保留。");

const confirmationSchema = z.enum(["confirmed", "unconfirmed"])
  .describe("由调用方核对来源后标记；未确认数据保留但不参与判定，工具不认证确认者身份。");
const sourceSchema = z.string().trim().min(1).max(300)
  .describe("可回查的报告/记录及页码标识；不要放姓名、电话或整段病历。");

export const findingSchema = z.object({
  state: z.enum(["present", "absent", "unknown"]),
  observedAt: timeSchema,
  source: sourceSchema,
  confirmation: confirmationSchema,
}).strict();

const valueSchema = z.union([
  z.number().finite().nonnegative().max(999999999999)
    .refine((value) => Number.isFinite(value) && new Decimal(value).decimalPlaces() <= 12, "数值最多12位小数；请按原检验值输入。"),
  z.string().regex(/^\d{1,12}(\.\d{1,12})?$/),
]).describe("非负实测值；最多12位整数和12位小数的十进制字符串可保留精确小数。无穷、范围符号、无单位数值不接受。");

function measurement<U extends [string, ...string[]]>(units: U) {
  return z.object({
    value: valueSchema,
    unit: z.enum(units),
    collectedAt: timeSchema,
    source: sourceSchema,
    confirmation: confirmationSchema,
  }).strict();
}

const ferritin = measurement(["ng/mL", "ug/L", "μg/L"]);
const platelets = measurement(["10^9/L", "10^3/uL"]);
const fibrinogen = measurement(["g/L", "mg/dL", "mg/L"]);
const triglycerides = measurement(["mg/dL", "mmol/L"]);
const enzyme = measurement(["U/L"]);
const hemoglobin = measurement(["g/L", "g/dL"]);
const neutrophils = measurement(["10^9/L", "10^3/uL"]);
const scd25 = measurement(["U/mL"]);
const optionalFinding = findingSchema.nullish();

const sjiaContext = z.object({
  assessmentDate: dateSchema,
  fever: optionalFinding.describe("发热：未提及即未知，不能推断不存在。"),
  knownOrSuspectedSjia: optionalFinding,
}).strict();

export const mas2016Schema = z.object({
  context: sjiaContext.extend({
    alternativeCausesExcluded: optionalFinding.describe("原表要求异常不能由其他情况解释；需临床复核，工具不自行排除。present表示已排除其他解释。"),
  }),
  labs: z.object({
    ferritin: ferritin.nullish(), platelets: platelets.nullish(), ast: enzyme.nullish(),
    triglycerides: triglycerides.nullish(), fibrinogen: fibrinogen.nullish(),
  }).strict(),
}).strict();

export const ms2019Schema = z.object({
  context: sjiaContext,
  clinical: z.object({
    cns: optionalFinding.describe("中枢神经系统受累，需临床确认；原文示例见get_scale_schema。"),
    hemorrhage: optionalFinding,
    activeArthritis: optionalFinding.describe("当前活动性关节炎，不能以既往关节炎或关节痛替代。"),
  }).strict(),
  labs: z.object({
    platelets: platelets.nullish(), ldh: enzyme.nullish(),
    fibrinogen: fibrinogen.nullish(), ferritin: ferritin.nullish(),
  }).strict(),
}).strict();

export const hlh2004Schema = z.object({
  context: z.object({
    assessmentDate: dateSchema,
    ageDays: z.number().int().nonnegative().max(100000).nullish()
      .describe("评估时出生后天数；<28天采用Hb<100g/L，否则<90g/L；未知保留，不猜年龄。"),
    molecularDiagnosis: optionalFinding.describe("符合HLH的分子诊断，由临床确认；基因变异本身不自动等价。"),
  }).strict(),
  clinical: z.object({
    fever: optionalFinding.describe("原表没有额外的温度或持续一周限定。"),
    splenomegaly: optionalFinding,
    hemophagocytosis: findingSchema.extend({
      site: z.enum(["bone_marrow", "spleen", "lymph_node"]).nullish(),
    }).strict().nullish().describe("原表限骨髓、脾或淋巴结；present必须提供部位。阴性不能排除HLH。"),
    nkActivityLowOrAbsent: optionalFinding.describe("NK活性降低/缺失，按本实验室参考；不是NK数量。"),
    noEvidenceOfMalignancy: optionalFinding.describe("原表背景要求，无恶性肿瘤证据；不是第九项。"),
    triglyceridesFasting: optionalFinding.describe("TG为空腹采样。present=确认空腹；未知或非空腹时TG不能确认为命中。"),
  }).strict(),
  labs: z.object({
    hemoglobin: hemoglobin.nullish(), platelets: platelets.nullish(),
    absoluteNeutrophils: neutrophils.nullish().describe("中性粒细胞绝对计数ANC，不是白细胞总数。"),
    triglycerides: triglycerides.nullish(), fibrinogen: fibrinogen.nullish(),
    ferritin: ferritin.nullish(), solubleCd25: scd25.nullish().describe("仅U/mL；pg/mL不可直接折算。"),
  }).strict(),
}).strict();

export const inputSchemas = { mas_2016: mas2016Schema, ms_2019: ms2019Schema, hlh_2004: hlh2004Schema };
export type Finding = z.infer<typeof findingSchema>;
export type Measurement = { value: number | string; unit: string; collectedAt: string; source: string; confirmation: "confirmed" | "unconfirmed" };
export type TriState = "met" | "not_met" | "unknown";

const triStateSchema = z.enum(["met", "not_met", "unknown"]);
type CriterionOutput = { id: string; rule: string; status: TriState; children?: CriterionOutput[] };
const criterionOutputSchema: z.ZodType<CriterionOutput> = z.lazy(() => z.object({
  id: z.string(), rule: z.string(), status: triStateSchema,
  children: z.array(criterionOutputSchema).optional(),
}).strict());

export const scoreOutputSchema = z.object({
  scaleId: z.enum(scaleIds), toolVersion: z.string(), ruleVersion: z.string(), assessmentDate: dateSchema,
  eligibility: triStateSchema, mathematicalStatus: triStateSchema,
  assessmentStatus: z.enum(["criteria_met", "criteria_not_met", "insufficient_data", "prerequisites_unconfirmed", "not_applicable", "clinical_review_required"]),
  interpretation: z.string(), criteria: z.array(criterionOutputSchema),
  confirmedMetCount: z.number().int().nonnegative(), unknownCriterionCount: z.number().int().nonnegative(),
  unknownInputs: z.array(z.string()), normalizedInputs: z.array(z.object({
    path: z.string(), original: z.record(z.unknown()).nullable(), value: z.string().nullable(),
    unit: z.string().nullable(), conversion: z.string(), usable: z.boolean(),
  }).strict()),
  source: z.object({ doi: z.string(), location: z.string(), pdf: z.string(), url: z.string().url(), sha256: z.string().length(64) }).strict(),
  clinicalReviewStatus: z.literal("not_signed_off"), selectionPolicy: z.literal("same_reported_calendar_date"), limitations: z.array(z.string()),
  score: z.string().nullable().optional(), displayScore: z.string().nullable().optional(),
  scoreComplete: z.boolean().optional(), cutoff: z.string().optional(), comparison: z.literal(">=").optional(), probability: z.null().optional(),
  contributions: z.array(z.object({ id: z.string(), coefficient: z.string(), value: z.string().nullable(), contribution: z.string().nullable() }).strict()).optional(),
  routes: z.object({ molecularDiagnosis: triStateSchema, fiveOfEight: triStateSchema }).strict().optional(),
  clinicalBackground: z.object({ alternativeCausesExcluded: triStateSchema.optional(), noEvidenceOfMalignancy: triStateSchema.optional() }).strict().optional(),
  triglyceridePolicy: z.literal("compare_original_parallel_threshold_in_reported_unit").optional(),
}).strict();

export class ScoringError extends Error {
  constructor(readonly code: string, message: string, readonly paths: string[] = []) {
    super(message);
    this.name = "ScoringError";
  }
}
