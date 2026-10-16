import { clinicalSections, metricDefinitions, type Child, type HealthRecord } from "../shared/types.js";

/** A source-indexed family summary, never a signed medical record or model diagnosis. */
export function medicalSummary(child: Child, records: HealthRecord[]) {
  const confirmed = records.filter(record => record.confirmation === "user_confirmed")
    .sort((a, b) => (a.occurredOn + (a.occurredTime ?? "")).localeCompare(b.occurredOn + (b.occurredTime ?? "")));
  const sections = Object.entries(clinicalSections).map(([key, label]) => ({
    key, label,
    entries: confirmed.filter(record => record.clinical?.[key as keyof typeof clinicalSections]?.trim()).map(record => ({
      text: record.clinical![key as keyof typeof clinicalSections]!, recordId: record.id, version: record.version,
      occurredOn: record.occurredOn, source: record.source, attachmentIds: record.attachmentIds,
    })),
  }));
  const timeline = confirmed.map(record => ({
    recordId: record.id, version: record.version, kind: record.kind, occurredOn: record.occurredOn,
    occurredTime: record.occurredTime, timezone: record.timezone, title: record.title,
    notes: record.notes, source: record.source, attachmentIds: record.attachmentIds,
    measurements: record.measurements.map(item => ({ ...item, label: metricDefinitions[item.code].label })),
  }));
  return {
    format: "family-medical-summary-v1", title: "就诊资料摘要（家长核对）", generatedAt: new Date().toISOString(),
    child: { nickname: child.nickname, birthYear: child.birthYear, diagnosis: child.diagnosis },
    notice: "仅整理家长已核对的当前版本；缺项不补写，不生成诊断或治疗建议；非医师签署病历。",
    excludedDrafts: records.length - confirmed.length, sections, timeline,
  };
}

export function summaryMarkdown(summary: ReturnType<typeof medicalSummary>): string {
  const lines = ["# " + summary.title, "", summary.notice, "",
    "患者代称：" + summary.child.nickname, "出生年：" + (summary.child.birthYear ?? "未记录"),
    "档案诊断（原记录）：" + (summary.child.diagnosis || "未记录"),
    "生成时间：" + summary.generatedAt, "未纳入待核对记录：" + summary.excludedDrafts, ""];
  for (const section of summary.sections) {
    lines.push("## " + section.label, "");
    if (!section.entries.length) lines.push("未记录。", "");
    for (const entry of section.entries) lines.push(entry.text, "",
      "来源：" + entry.source + "；日期：" + entry.occurredOn + "；记录：" + entry.recordId + " v" + entry.version, "");
  }
  lines.push("## 按时间整理的记录", "");
  for (const record of summary.timeline) {
    lines.push("### " + record.occurredOn + (record.occurredTime ? " " + record.occurredTime : "") + " " + record.title,
      "", "时区：" + record.timezone, "来源：" + record.source, "记录：" + record.recordId + " v" + record.version, "");
    if (record.notes) lines.push(record.notes, "");
    for (const item of record.measurements) lines.push("- " + item.label + "：" + item.value + " " + item.unit);
    lines.push("");
  }
  return lines.join("\n");
}
