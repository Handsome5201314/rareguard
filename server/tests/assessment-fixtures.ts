import type { Finding, Measurement } from "../src/internal-assessments/contracts.js";

// 所有数值为原表边界构造数据，不是真实患者，不用于临床效果验证。
export const DATE = "2026-10-10";
export const finding = (state: Finding["state"] = "present"): Finding => ({
  state, observedAt: DATE, source: "constructed-test/clinical", confirmation: "confirmed",
});
export const lab = (value: number | string, unit: string): Measurement => ({
  value, unit, collectedAt: DATE, source: "constructed-test/lab", confirmation: "confirmed",
});
export const sjiaContext = () => ({ assessmentDate: DATE, fever: finding(), knownOrSuspectedSjia: finding() });
export const masInput = () => ({
  context: { ...sjiaContext(), alternativeCausesExcluded: finding() },
  labs: { ferritin: lab(685, "ng/mL"), platelets: lab(181, "10^9/L"), ast: lab(48, "U/L"), triglycerides: lab(156, "mg/dL"), fibrinogen: lab("3.6", "g/L") },
});
export const msInput = () => ({
  context: sjiaContext(),
  clinical: { cns: finding("absent"), hemorrhage: finding("absent"), activeArthritis: finding("absent") },
  labs: { platelets: lab(200, "10^9/L"), ldh: lab(300, "U/L"), fibrinogen: lab(500, "mg/dL"), ferritin: lab(2000, "ng/mL") },
});
export const hlhInput = () => ({
  context: { assessmentDate: DATE, ageDays: 365, molecularDiagnosis: finding("absent") },
  clinical: {
    fever: finding(), splenomegaly: finding(),
    hemophagocytosis: { ...finding("absent"), site: "bone_marrow" },
    nkActivityLowOrAbsent: finding("absent"), noEvidenceOfMalignancy: finding(), triglyceridesFasting: finding(),
  },
  labs: {
    hemoglobin: lab(89, "g/L"), platelets: lab(99, "10^9/L"), absoluteNeutrophils: lab("0.9", "10^9/L"),
    triglycerides: lab(3, "mmol/L"), fibrinogen: lab("1.5", "g/L"), ferritin: lab(500, "ug/L"), solubleCd25: lab(2399, "U/mL"),
  },
});
