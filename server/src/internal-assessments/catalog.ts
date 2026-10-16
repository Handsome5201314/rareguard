import { zodToJsonSchema } from "zod-to-json-schema";
import { inputSchemas, scoreOutputSchema, type ScaleId } from "./contracts.js";

export const TOOL_VERSION = "0.1.0";
export const RULE_VERSION = "1.0.0";

const catalog = {
  mas_2016: {
    title: "2016 sJIA-MAS 分类标准",
    purpose: "发热且已知/疑似sJIA时的分类条目核对，不等于确诊或排除MAS。",
    rule: "Ferritin >684 ng/mL AND >=2 of: PLT <=181 10^9/L; AST >48 U/L; TG >156 mg/dL; Fbg <=360 mg/dL. 异常不能由其他情况解释。",
    source: {
      doi: "10.1002/art.39332", location: "PDF第7页Figure 2；期刊572页",
      pdf: "../医生包-帅帅/资料/原始文献/Ravelli-2016-MAS-Criteria-art39332.pdf",
      url: "https://air.unimi.it/bitstream/2434/723990/2/2016%20MAS.pdf",
      sha256: "2aac095071b844ebf5363fe4fc0e9071ccb4c5997c5934abc2fc60332f9d0ed8",
    },
  },
  ms_2019: {
    title: "2019 MAS/sJIA（MS）评分",
    purpose: "发热且已知/疑似sJIA时的诊断辅助分数；MS >= -2.1时原研究建议考虑MAS。",
    rule: "2.44*CNS +1.54*hemorrhage -1.30*activeArthritis -0.003*PLT +0.001*LDH -0.004*Fbg +0.0001*ferritin; Fbg=mg/dL; PLT=10^9/L; LDH=U/L; ferritin=ng/mL. 无截距或log变换。",
    clinicalDefinitions: {
      cns: "原研究列嗜睡、惊厥、易激惹、意识混乱、头痛、情绪改变或昏迷；临床归类由负责医生确认。",
      hemorrhage: "原研究列瘀点、瘀斑/紫癜、黏膜或消化道出血、血管内凝血；整个变量只编码一次。",
      activeArthritis: "当前活动性关节炎；既往史和单独关节痛不能替代。",
    },
    source: {
      doi: "10.1136/annrheumdis-2019-215211", location: "PDF第4页Table 4；期刊1360页；临床定义第2–3页",
      pdf: "../医生包-帅帅/资料/原始文献/Minoia-2019-MS-Score-215211.pdf",
      url: "https://boa.unimib.it/bitstream/10281/524177/2/Minoia-2019-Annals%20of%20the%20Rheumatic%20Diseases-VoR.pdf",
      sha256: "64741c97b92b546471f6cace4fd7705c0ca595953b339ca0d9e1752309d30e32",
    },
  },
  hlh_2004: {
    title: "HLH-2004 两路径与八项分组",
    purpose: "HLH指南条目核对：符合HLH的分子诊断，或八项至少五项；不是sJIA特异早期预警模型。",
    rule: "Molecular diagnosis consistent with HLH OR >=5/8. Cytopenias >=2 lineages count ONCE; fasting TG >=3.0 mmol/L (original parallel threshold >=265 mg/dL) OR Fbg <=1.5 g/L count ONCE; ferritin >=500 ug/L; sCD25 >=2400 U/mL. NK activity, not count. Hb <90 g/L (<100 when ageDays <28), PLT <100 10^9/L, ANC <1.0 10^9/L.",
    source: {
      doi: "10.1002/pbc.21039", location: "PDF第3页Table I，early-view版",
      pdf: "../医生包-帅帅/资料/原始文献/Henter-2007-HLH-2004-pbc21039.pdf",
      url: "https://pho.barnlakarforeningen.se/wp-content/uploads/sites/20/2019/03/VPH-HLH-2004-PBC.pdf",
      sha256: "45d89cfcbfdb71d77ed992f22e1e947cfa014a8a2471a7811271b3aea45260ec",
    },
  },
};

export function listSupportedScales() {
  return Object.entries(catalog).map(([scaleId, definition]) => ({
    scaleId, ...definition, toolVersion: TOOL_VERSION, ruleVersion: RULE_VERSION,
    clinicalReviewStatus: "not_signed_off", implementationStatus: "original_table_verified",
  }));
}

export function getScaleSchema(scaleId: ScaleId) {
  return {
    ...catalog[scaleId], scaleId, toolVersion: TOOL_VERSION, ruleVersion: RULE_VERSION,
    clinicalReviewStatus: "not_signed_off", implementationStatus: "original_table_verified",
    inputSchema: zodToJsonSchema(inputSchemas[scaleId], { $refStrategy: "none" }),
    outputSchema: zodToJsonSchema(scoreOutputSchema, { name: "ScoreResult" }),
    selectionPolicy: "same_reported_calendar_date",
    numericPolicy: "decimal_40_digits_compare_before_display_rounding",
    missingPolicy: "missing/null/unknown/unconfirmed stay unknown; never fill zero",
    unitPolicy: scaleId === "hlh_2004"
      ? "TG按原输入单位比较原表双阈值，不强行等同3.0mmol/L与265mg/dL；其他单位作精确换算。"
      : "TG mmol/L乘88.57转mg/dL；Fbg g/L乘100转mg/dL；原值原单位保留。",
  };
}

export function sourceFor(scaleId: ScaleId) { return catalog[scaleId].source; }
