import { Decimal } from "decimal.js";
import { inputSchemas, ScoringError, type Finding, type Measurement, type ScaleId, type TriState } from "./contracts.js";
import { RULE_VERSION, TOOL_VERSION, sourceFor } from "./catalog.js";

const D = Decimal.clone({ precision: 40 });
type Criterion = { id: string; rule: string; status: TriState; children?: Criterion[] };
type AssessmentStatus = "criteria_met" | "criteria_not_met" | "insufficient_data" | "prerequisites_unconfirmed" | "not_applicable" | "clinical_review_required";
type NormalizedInput = {
  path: string; original: Measurement | Finding | null; value: string | null;
  unit: string | null; conversion: string; usable: boolean;
};

export function atLeast(statuses: TriState[], n: number): TriState {
  const met = statuses.filter((s) => s === "met").length;
  const unknown = statuses.filter((s) => s === "unknown").length;
  return met >= n ? "met" : met + unknown < n ? "not_met" : "unknown";
}

function all(statuses: TriState[]): TriState {
  return statuses.includes("not_met") ? "not_met" : statuses.includes("unknown") ? "unknown" : "met";
}

function enforceDates(value: unknown, date: string, path = "input"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if ((key === "collectedAt" || key === "observedAt") && typeof item === "string" && item.slice(0, 10) !== date) {
      throw new ScoringError("MIXED_DATES", "一次评分必须使用同一报告日历日期的数据；请按日期分别调用。临床允许时间窗尚未确定。", [`${path}.${key}`]);
    }
    enforceDates(item, date, `${path}.${key}`);
  }
}

class Evaluation {
  readonly normalizedInputs: NormalizedInput[] = [];
  readonly unknownInputs: string[] = [];

  finding(path: string, value: Finding | null | undefined): TriState {
    const usable = !!value && value.confirmation === "confirmed" && value.state !== "unknown";
    this.normalizedInputs.push({ path, original: value ?? null, value: usable ? (value.state === "present" ? "1" : "0") : null, unit: null, conversion: "confirmed present=1, absent=0; unknown/unconfirmed不可编码", usable });
    if (!usable) this.unknownInputs.push(path);
    return usable ? (value.state === "present" ? "met" : "not_met") : "unknown";
  }

  lab(path: string, value: Measurement | null | undefined, targetUnit: string): Decimal | null {
    const usable = !!value && value.confirmation === "confirmed";
    let normalized: Decimal | null = value ? new D(value.value) : null;
    let conversion = "数值等价，无比例换算";
    if (value && normalized) {
      if (targetUnit === "mg/dL" && value.unit === "g/L") { normalized = normalized.mul(100); conversion = "g/L ×100 → mg/dL"; }
      if (targetUnit === "mg/dL" && value.unit === "mg/L") { normalized = normalized.div(10); conversion = "mg/L ÷10 → mg/dL"; }
      if (targetUnit === "mg/dL" && value.unit === "mmol/L") { normalized = normalized.mul("88.57"); conversion = "TG mmol/L ×88.57 → mg/dL；固定换算系数，未先取整"; }
      if (targetUnit === "g/L" && value.unit === "mg/dL") { normalized = normalized.div(100); conversion = "mg/dL ÷100 → g/L"; }
      if (targetUnit === "g/L" && value.unit === "mg/L") { normalized = normalized.div(1000); conversion = "mg/L ÷1000 → g/L"; }
      if (targetUnit === "g/L" && value.unit === "g/dL") { normalized = normalized.mul(10); conversion = "g/dL ×10 → g/L"; }
    }
    this.normalizedInputs.push({ path, original: value ?? null, value: normalized?.toString() ?? null, unit: targetUnit, conversion, usable });
    if (!usable) this.unknownInputs.push(path);
    return usable ? normalized : null;
  }
}

function criterion(id: string, rule: string, value: Decimal | null, operator: "gt" | "gte" | "lt" | "lte", threshold: string): Criterion {
  return { id, rule, status: value === null ? "unknown" : value[operator](threshold) ? "met" : "not_met" };
}

function group(id: string, rule: string, children: Criterion[], n: number): Criterion {
  return { id, rule, children, status: atLeast(children.map((c) => c.status), n) };
}

function eligibility(e: Evaluation, context: { fever?: Finding | null; knownOrSuspectedSjia?: Finding | null }): TriState {
  return all([e.finding("context.fever", context.fever), e.finding("context.knownOrSuspectedSjia", context.knownOrSuspectedSjia)]);
}

function statusFor(criteria: TriState, eligible: TriState, needsReview: boolean): AssessmentStatus {
  if (eligible === "not_met") return "not_applicable";
  if (eligible === "unknown") return "prerequisites_unconfirmed";
  if (criteria === "unknown") return "insufficient_data";
  if (criteria === "not_met") return "criteria_not_met";
  return needsReview ? "clinical_review_required" : "criteria_met";
}

const messages: Record<AssessmentStatus, string> = {
  criteria_met: "已确认输入满足原规则的条目组合/界值，需临床解释与复核；工具不作诊断。",
  criteria_not_met: "已确认输入未达原规则组合/界值，不能据此排除MAS/HLH或判断安全。",
  insufficient_data: "资料不足以判定；请核对缺项、未知和未确认输入。",
  prerequisites_unconfirmed: "发热或已知/疑似sJIA适用前提待确认，不能将数学结果作为适用人群结论。",
  not_applicable: "已确认适用前提不成立；仅列条目/数学核对，不作该工具的适用结论。",
  clinical_review_required: "条目组合已达，但原表背景要求尚未通过临床复核；请人工复核，不能直接宣称满足分类/诊断要求。",
};

function result(scaleId: ScaleId, date: string, e: Evaluation, eligible: TriState, criteria: Criterion[], mathematicalStatus: TriState, needsReview = false) {
  const assessmentStatus = statusFor(mathematicalStatus, eligible, needsReview);
  return {
    scaleId, toolVersion: TOOL_VERSION, ruleVersion: RULE_VERSION, assessmentDate: date,
    eligibility: eligible, mathematicalStatus, assessmentStatus, interpretation: messages[assessmentStatus],
    criteria, confirmedMetCount: criteria.filter((c) => c.status === "met").length,
    unknownCriterionCount: criteria.filter((c) => c.status === "unknown").length,
    unknownInputs: [...new Set(e.unknownInputs)], normalizedInputs: e.normalizedInputs,
    source: sourceFor(scaleId), clinicalReviewStatus: "not_signed_off",
    selectionPolicy: "same_reported_calendar_date",
    limitations: [
      "静态规则核对，不输出风险概率、三色安全灯或治疗决策；未达界值不排除风险。",
      "同一报告日历日期只是避免自动跨日拼接的工程限制，不是经验证的临床采样窗口。",
      "confirmed为调用方声明，工具不认证临床归类、患者一致性或来源真实性。",
    ],
  };
}

function scoreMas2016(raw: unknown) {
  const input = inputSchemas.mas_2016.parse(raw);
  enforceDates(input, input.context.assessmentDate);
  const e = new Evaluation();
  const eligible = eligibility(e, input.context);
  const alternativeCausesExcluded = e.finding("context.alternativeCausesExcluded", input.context.alternativeCausesExcluded);
  const ferritin = criterion("ferritin", ">684 ng/mL（必需项）", e.lab("labs.ferritin", input.labs.ferritin, "ng/mL"), "gt", "684");
  const others = [
    criterion("platelets", "<=181 10^9/L", e.lab("labs.platelets", input.labs.platelets, "10^9/L"), "lte", "181"),
    criterion("ast", ">48 U/L", e.lab("labs.ast", input.labs.ast, "U/L"), "gt", "48"),
    criterion("triglycerides", ">156 mg/dL", e.lab("labs.triglycerides", input.labs.triglycerides, "mg/dL"), "gt", "156"),
    criterion("fibrinogen", "<=360 mg/dL", e.lab("labs.fibrinogen", input.labs.fibrinogen, "mg/dL"), "lte", "360"),
  ];
  const optionalGroup = group("at_least_two_of_four", "四项至少两项", others, 2);
  return {
    ...result("mas_2016", input.context.assessmentDate, e, eligible, [ferritin, optionalGroup], all([ferritin.status, optionalGroup.status]), alternativeCausesExcluded !== "met"),
    clinicalBackground: { alternativeCausesExcluded },
  };
}

function scoreMs2019(raw: unknown) {
  const input = inputSchemas.ms_2019.parse(raw);
  enforceDates(input, input.context.assessmentDate);
  const e = new Evaluation();
  const eligible = eligibility(e, input.context);
  const clinicalValue = (path: string, value: Finding | null | undefined): Decimal | null => {
    const state = e.finding(path, value);
    return state === "unknown" ? null : new D(state === "met" ? 1 : 0);
  };
  const terms = [
    { id: "cns", coefficient: "2.44", value: clinicalValue("clinical.cns", input.clinical.cns) },
    { id: "hemorrhage", coefficient: "1.54", value: clinicalValue("clinical.hemorrhage", input.clinical.hemorrhage) },
    { id: "activeArthritis", coefficient: "-1.30", value: clinicalValue("clinical.activeArthritis", input.clinical.activeArthritis) },
    { id: "platelets", coefficient: "-0.003", value: e.lab("labs.platelets", input.labs.platelets, "10^9/L") },
    { id: "ldh", coefficient: "0.001", value: e.lab("labs.ldh", input.labs.ldh, "U/L") },
    { id: "fibrinogen", coefficient: "-0.004", value: e.lab("labs.fibrinogen", input.labs.fibrinogen, "mg/dL") },
    { id: "ferritin", coefficient: "0.0001", value: e.lab("labs.ferritin", input.labs.ferritin, "ng/mL") },
  ];
  const contributions = terms.map(({ id, coefficient, value }) => ({ id, coefficient, value: value?.toString() ?? null, contribution: value?.mul(coefficient).toString() ?? null }));
  const complete = terms.every((t) => t.value !== null);
  const total = complete ? terms.reduce((sum, t) => sum.add(t.value!.mul(t.coefficient)), new D(0)) : null;
  const scoreCriterion = criterion("ms_cutoff", "MS >= -2.1；原研究建议考虑MAS", total, "gte", "-2.1");
  return {
    ...result("ms_2019", input.context.assessmentDate, e, eligible, [scoreCriterion], scoreCriterion.status),
    score: total?.toString() ?? null,
    displayScore: total?.toFixed(4) ?? null,
    scoreComplete: complete, contributions, cutoff: "-2.1", comparison: ">=", probability: null,
  };
}

function scoreHlh2004(raw: unknown) {
  const input = inputSchemas.hlh_2004.parse(raw);
  enforceDates(input, input.context.assessmentDate);
  if (input.clinical.hemophagocytosis?.state === "present" && !input.clinical.hemophagocytosis.site) {
    throw new ScoringError("SITE_REQUIRED", "噬血现象存在时必须提供原表支持的部位。", ["clinical.hemophagocytosis.site"]);
  }
  const e = new Evaluation();
  const molecular = e.finding("context.molecularDiagnosis", input.context.molecularDiagnosis);
  const noMalignancy = e.finding("clinical.noEvidenceOfMalignancy", input.clinical.noEvidenceOfMalignancy);
  const findingCriterion = (id: string, rule: string, value: Finding | null | undefined): Criterion => ({ id, rule, status: e.finding(`clinical.${id}`, value) });
  const hb = e.lab("labs.hemoglobin", input.labs.hemoglobin, "g/L");
  let hbCriterion: Criterion;
  if (input.context.ageDays == null) {
    // 在未知年龄下，<90两年龄段均命中，>=100均不命中；90–<100不能猜。
    const state = hb === null ? "unknown" : hb.lt(90) ? "met" : hb.gte(100) ? "not_met" : "unknown";
    hbCriterion = { id: "hemoglobin", rule: "<90 g/L；出生<28天<100 g/L；年龄未知时使用两分支共同结论", status: state };
    e.unknownInputs.push("context.ageDays");
  } else {
    const cutoff = input.context.ageDays < 28 ? "100" : "90";
    hbCriterion = criterion("hemoglobin", `<${cutoff} g/L（ageDays=${input.context.ageDays}）`, hb, "lt", cutoff);
  }
  const cytopenias = group("cytopenias", "Hb/PLT/ANC至少两系减少，整个组只计一项", [
    hbCriterion,
    criterion("platelets", "<100 10^9/L", e.lab("labs.platelets", input.labs.platelets, "10^9/L"), "lt", "100"),
    criterion("absoluteNeutrophils", "<1.0 10^9/L", e.lab("labs.absoluteNeutrophils", input.labs.absoluteNeutrophils, "10^9/L"), "lt", "1"),
  ], 2);
  const fasting = e.finding("clinical.triglyceridesFasting", input.clinical.triglyceridesFasting);
  const tgUnit = input.labs.triglycerides?.unit ?? "mmol/L";
  const tgValue = e.lab("labs.triglycerides", input.labs.triglycerides, tgUnit);
  const tg = criterion("fastingTriglycerides", tgUnit === "mmol/L" ? "空腹TG >=3.0 mmol/L" : "空腹TG >=265 mg/dL（原表并列阈值）", tgValue, "gte", tgUnit === "mmol/L" ? "3" : "265");
  // 非空腹不能证实此项，不当作正常值；Fbg可独立确认整个OR组。
  if (fasting !== "met") tg.status = "unknown";
  const metabolic = group("triglycerides_or_fibrinogen", "空腹高TG和/或低Fbg，整个组只计一项", [
    tg, criterion("fibrinogen", "<=1.5 g/L", e.lab("labs.fibrinogen", input.labs.fibrinogen, "g/L"), "lte", "1.5"),
  ], 1);
  const criteria = [
    findingCriterion("fever", "发热（原表无额外温度/持续时长限定）", input.clinical.fever),
    findingCriterion("splenomegaly", "脾大", input.clinical.splenomegaly),
    cytopenias, metabolic,
    findingCriterion("hemophagocytosis", "骨髓/脾/淋巴结噬血；阴性不能排除", input.clinical.hemophagocytosis),
    findingCriterion("nkActivityLowOrAbsent", "NK低/无活性，按本实验室参考，非细胞数量", input.clinical.nkActivityLowOrAbsent),
    criterion("ferritin", ">=500 ug/L（等价ng/mL）", e.lab("labs.ferritin", input.labs.ferritin, "ng/mL"), "gte", "500"),
    criterion("solubleCd25", ">=2400 U/mL", e.lab("labs.solubleCd25", input.labs.solubleCd25, "U/mL"), "gte", "2400"),
  ];
  const eightCriteria = atLeast(criteria.map((c) => c.status), 5);
  const combined = atLeast([molecular, eightCriteria], 1);
  return {
    ...result("hlh_2004", input.context.assessmentDate, e, "met", criteria, combined, molecular !== "met" && noMalignancy !== "met"),
    routes: { molecularDiagnosis: molecular, fiveOfEight: eightCriteria },
    clinicalBackground: { noEvidenceOfMalignancy: noMalignancy },
    triglyceridePolicy: "compare_original_parallel_threshold_in_reported_unit",
  };
}

export function scoreAssessment(scaleId: ScaleId, input: unknown) {
  switch (scaleId) {
    case "mas_2016": return scoreMas2016(input);
    case "ms_2019": return scoreMs2019(input);
    case "hlh_2004": return scoreHlh2004(input);
    default: throw new ScoringError("UNKNOWN_SCALE", "不支持的量表ID。");
  }
}
