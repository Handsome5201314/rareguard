import test from "node:test";
import assert from "node:assert/strict";
import { scoreAssessment } from "../src/internal-assessments/scoring.js";
import { getScaleSchema, listSupportedScales } from "../src/internal-assessments/catalog.js";
import { inputSchemas, scoreOutputSchema, ScoringError } from "../src/internal-assessments/contracts.js";
import { DATE, finding, hlhInput, lab, masInput, msInput } from "./assessment-fixtures.js";

const scoreMas = (input: unknown) => scoreAssessment("mas_2016", input);
const scoreMs = (input: unknown) => scoreAssessment("ms_2019", input);
const scoreHlh = (input: unknown) => scoreAssessment("hlh_2004", input);

test("2016原表各不等号，铁蛋白必需且四项>=2", () => {
  assert.equal(scoreMas(masInput()).assessmentStatus, "criteria_met");
  const ferritin = masInput(); ferritin.labs.ferritin.value = 684;
  assert.equal(scoreMas(ferritin).mathematicalStatus, "not_met");
  for (const [field, value, expected] of [
    ["platelets", 181, "met"], ["platelets", "181.0001", "not_met"],
    ["ast", 48, "not_met"], ["ast", "48.0001", "met"],
    ["triglycerides", 156, "not_met"], ["triglycerides", "156.0001", "met"],
    ["fibrinogen", "3.6", "met"], ["fibrinogen", "3.6001", "not_met"],
  ] as const) {
    const input = masInput(); input.labs[field].value = value;
    assert.equal(scoreMas(input).criteria[1]?.children?.find((c) => c.id === field)?.status, expected, field);
  }
});

test("2016有足够命中时允许部分缺项；未知不补正常", () => {
  const input = masInput();
  const partial = { ...input, labs: { ferritin: input.labs.ferritin, platelets: input.labs.platelets, fibrinogen: input.labs.fibrinogen } };
  assert.equal(scoreMas(partial).mathematicalStatus, "met");
  assert.ok(scoreMas(partial).unknownInputs.includes("labs.ast"));
  assert.equal(scoreMas({ ...input, labs: { ferritin: input.labs.ferritin } }).assessmentStatus, "insufficient_data");
});

test("适用前提不成立/未知与未达界值分开；其他解释需复核", () => {
  const input = masInput();
  input.context.fever = finding("absent");
  assert.equal(scoreMas(input).assessmentStatus, "not_applicable");
  input.context.fever = finding("unknown");
  assert.equal(scoreMas(input).assessmentStatus, "prerequisites_unconfirmed");
  input.context.fever = finding(); input.context.alternativeCausesExcluded = finding("unknown");
  assert.equal(scoreMas(input).assessmentStatus, "clinical_review_required");
});

test("2016单位转换后比较TG，原值/时间/来源保留", () => {
  const input = masInput(); input.labs.triglycerides = lab("1.762", "mmol/L");
  const result = scoreMas(input);
  const normalized = result.normalizedInputs.find((n) => n.path === "labs.triglycerides");
  assert.equal(normalized?.value, "156.06034");
  assert.deepEqual(normalized?.original, input.labs.triglycerides);
  assert.equal(result.criteria[1]?.children?.find((c) => c.id === "triglycerides")?.status, "met");
});

test("MS精确-2.1及g/L、mg/L换算；无截距/log/概率", () => {
  for (const [value, unit] of [[500, "mg/dL"], [5, "g/L"], [5000, "mg/L"]] as const) {
    const input = msInput(); input.labs.fibrinogen = lab(value, unit);
    const result = scoreMs(input);
    assert.ok("score" in result);
    assert.equal(result.score, "-2.1");
    assert.equal(result.mathematicalStatus, "met");
    assert.equal(result.probability, null);
  }
});

test("MS比较先于显示取整；当前活动性关节炎负贡献", () => {
  const input = msInput(); input.labs.fibrinogen.value = "500.00001";
  const below = scoreMs(input); assert.ok("score" in below);
  assert.equal(below.displayScore, "-2.1000");
  assert.equal(below.score, "-2.10000004");
  assert.equal(below.mathematicalStatus, "not_met");
  input.labs.fibrinogen.value = 500; input.clinical.activeArthritis = finding();
  const arthritis = scoreMs(input); assert.ok("score" in arthritis);
  assert.equal(arthritis.score, "-3.4");
  assert.equal(arthritis.contributions.find((t) => t.id === "activeArthritis")?.contribution, "-1.3");
});

test("MS未知/缺失/未确认七项中任一项，不输出完整分数", () => {
  const input = msInput();
  input.clinical.cns = finding("unknown");
  const unknown = scoreMs(input); assert.ok("score" in unknown);
  assert.equal(unknown.score, null); assert.equal(unknown.assessmentStatus, "insufficient_data");
  input.clinical.cns = finding("absent"); input.labs.ferritin.confirmation = "unconfirmed";
  const unconfirmed = scoreMs(input); assert.ok("score" in unconfirmed);
  assert.equal(unconfirmed.score, null); assert.ok(unconfirmed.unknownInputs.includes("labs.ferritin"));
  const omitted = { ...input, labs: { platelets: input.labs.platelets, ldh: input.labs.ldh } };
  const missing = scoreMs(omitted); assert.ok("score" in missing); assert.equal(missing.scoreComplete, false);
});

test("MS七个系数独立的手算结果", () => {
  const input = msInput(); input.clinical.cns = finding(); input.clinical.hemorrhage = finding(); input.clinical.activeArthritis = finding();
  const result = scoreMs(input); assert.ok("score" in result);
  assert.equal(result.score, "0.58"); // -2.1 +2.44 +1.54 -1.30
  assert.equal(result.contributions.length, 7);
});

test("HLH三低系和TG/Fbg双阳性分别整组只计一次，正好5/8", () => {
  const result = scoreHlh(hlhInput()); assert.ok("routes" in result);
  assert.equal(result.criteria.length, 8);
  assert.equal(result.confirmedMetCount, 5);
  assert.equal(result.routes.fiveOfEight, "met");
  assert.equal(result.assessmentStatus, "criteria_met");
});

test("HLH严格细胞边界；新生儿出生<28天，ANC不能替换白细胞", () => {
  const input = hlhInput();
  input.labs.hemoglobin.value = 90; input.labs.platelets.value = 100; input.labs.absoluteNeutrophils.value = 1;
  assert.equal(scoreHlh(input).criteria[2]?.status, "not_met");
  input.labs.hemoglobin.value = 95; input.labs.platelets.value = 99;
  input.context.ageDays = 27;
  assert.equal(scoreHlh(input).criteria[2]?.status, "met");
  input.context.ageDays = 28;
  assert.equal(scoreHlh(input).criteria[2]?.status, "not_met");
  const bad = { ...input, labs: { ...input.labs, whiteBloodCells: lab(1, "10^9/L") } };
  assert.throws(() => scoreHlh(bad));
});

test("HLH年龄未知时Hb90–100之间未知；两系已低仍能确认组", () => {
  const input = hlhInput(); input.labs.hemoglobin.value = 95;
  const missingAge = { ...input, context: { assessmentDate: DATE, molecularDiagnosis: finding("absent") } };
  assert.equal(scoreHlh(missingAge).criteria[2]?.children?.[0]?.status, "unknown");
  assert.equal(scoreHlh(missingAge).criteria[2]?.status, "met");
  input.labs.platelets.value = 100;
  assert.equal(scoreHlh({ ...missingAge, labs: input.labs }).criteria[2]?.status, "unknown");
});

test("HLH原表TG双单位边界分别比较，未空腹不确认TG", () => {
  for (const [value, unit, expected] of [[3, "mmol/L", "met"], ["2.999", "mmol/L", "not_met"], [265, "mg/dL", "met"], ["264.999", "mg/dL", "not_met"]] as const) {
    const input = hlhInput(); input.labs.triglycerides = lab(value, unit); input.labs.fibrinogen.value = 2;
    assert.equal(scoreHlh(input).criteria[3]?.status, expected);
  }
  const input = hlhInput(); input.clinical.triglyceridesFasting = finding("unknown");
  assert.equal(scoreHlh(input).criteria[3]?.status, "met"); // Fbg独立命中
  input.labs.fibrinogen.value = 2;
  assert.equal(scoreHlh(input).criteria[3]?.status, "unknown");
  input.clinical.triglyceridesFasting = finding("absent");
  assert.equal(scoreHlh(input).criteria[3]?.status, "unknown");
});

test("HLH分子诊断路径不依赖凑够5项；不足项及分子未知不补负", () => {
  const input = { context: { assessmentDate: DATE, molecularDiagnosis: finding() }, clinical: {}, labs: {} };
  const molecular = scoreHlh(input); assert.ok("routes" in molecular);
  assert.equal(molecular.assessmentStatus, "criteria_met"); assert.equal(molecular.confirmedMetCount, 0);
  input.context.molecularDiagnosis = finding("unknown");
  assert.equal(scoreHlh(input).mathematicalStatus, "unknown");
});

test("HLH恶性肿瘤背景不是第九项；噬血阳性必须有原表部位", () => {
  const input = hlhInput(); input.clinical.noEvidenceOfMalignancy = finding("unknown");
  assert.equal(scoreHlh(input).criteria.length, 8);
  assert.equal(scoreHlh(input).assessmentStatus, "clinical_review_required");
  assert.throws(() => scoreHlh({ ...input, clinical: { ...input.clinical, hemophagocytosis: finding() } }), (e) => e instanceof ScoringError && e.code === "SITE_REQUIRED");
  assert.throws(() => scoreHlh({ ...input, clinical: { ...input.clinical, hemophagocytosis: { ...finding(), site: "liver" } } }));
});

test("HLH铁蛋白500及sCD25 2400均计入，拒绝pg/mL", () => {
  const input = hlhInput(); input.labs.solubleCd25.value = 2400;
  assert.equal(scoreHlh(input).criteria[6]?.status, "met");
  assert.equal(scoreHlh(input).criteria[7]?.status, "met");
  input.labs.solubleCd25.unit = "pg/mL";
  assert.throws(() => scoreHlh(input));
});

test("拒绝无单位、负数、无限、伪临床布尔、额外字段，不读病历", () => {
  for (const value of [-1, Infinity, NaN, 1e-13, ">1000", "", "1e3"] as const) {
    const input = msInput(); input.labs.ferritin.value = value;
    assert.throws(() => scoreMs(input));
  }
  assert.throws(() => scoreMs({ ...msInput(), patientName: "synthetic-test" }));
  assert.throws(() => scoreMs({ ...msInput(), clinical: { cns: false } }));
  assert.throws(() => scoreMs({ ...msInput(), labs: { ferritin: { value: 2000 } } }));
});

test("三套结果符合公开输出Schema，精确数值以字符串输出", () => {
  for (const result of [scoreMas(masInput()), scoreMs(msInput()), scoreHlh(hlhInput())]) {
    assert.doesNotThrow(() => scoreOutputSchema.parse(result));
  }
});

test("拒绝跨日拼接；保留日期/时间精度和原时区，不用上传日代替", () => {
  const input = msInput(); input.labs.ldh.collectedAt = "2026-10-09";
  assert.throws(() => scoreMs(input), (e) => e instanceof ScoringError && e.code === "MIXED_DATES");
  input.labs.ldh.collectedAt = `${DATE}T23:59:00-07:00`;
  assert.equal(scoreMs(input).assessmentDate, DATE);
  input.labs.ldh.collectedAt = "2026-02-30";
  assert.throws(() => scoreMs(input));
});

// Bibliographic metadata is preserved; PDFs are not runtime dependencies.
test("standalone assessment catalog retains schemas and source provenance", () => {
  assert.equal(listSupportedScales().length, 3);
  for (const entry of listSupportedScales()) {
    const schema = getScaleSchema(entry.scaleId as keyof typeof inputSchemas);
    assert.ok("type" in schema.inputSchema);
    assert.equal(schema.inputSchema.type, "object");
    assert.match(entry.source.doi, /^10\./);
    assert.match(entry.source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(new URL(entry.source.url).protocol, "https:");
  }
});
