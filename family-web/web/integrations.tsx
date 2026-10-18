import { useEffect, useState, type FormEvent } from "react";
import { Copy, Download, Plug, ShieldCheck } from "lucide-react";
import { agentScopes, type AgentGrant, type AgentScope, type Child, type MedicalSummary, type User } from "../../server/src/shared/types";
import { connectionPackage } from "../../server/src/shared/connection-package";
import { api, message } from "./api";
import { Button, Empty, ErrorNotice, Field, Loading } from "./components";

const scopeNames: Record<AgentScope, string> = {
  "profiles:read": "查看本人和孩子档案、档案历史", "profiles:write": "建立和修改本人、孩子档案", "profiles:delete": "按明确指示移除档案",
  "records:read": "读取记录、原件目录、趋势与摘要", "drafts:write": "创建和修订本连接的待核对草稿", "records:manage": "按明确指示修订、核对确认及删除记录",
  "attachments:read": "读取私有 PDF／照片原件", "attachments:write": "上传 PDF／照片原件", "attachments:delete": "删除未被历史引用的原件",
  "shares:manage": "按明确指示创建、查看及撤销限时分享", "exports:read": "按明确指示导出患者资料", "audit:read": "查看本账号操作审计",
  "invites:write": "创建家长邀请码（仅管理员）", "validation:consent": "按单独明确指示变更内部验证同意",
};
const usualScopes = agentScopes.filter(scope => scope !== "invites:write" && scope !== "validation:consent");
const patientScopes: AgentScope[] = ["records:read", "drafts:write", "attachments:write"];
export function AgentConnections({ child, user }: { child?: Child; user: User }) {
  const [access, setAccess] = useState<"family" | "patient">("family");
  const [grants, setGrants] = useState<AgentGrant[] | null>(null), [endpoint, setEndpoint] = useState("");
  const [name, setName] = useState("我的 Octop 病程助手"), [days, setDays] = useState(7), [scopes, setScopes] = useState<AgentScope[]>([...usualScopes]);
  const [consent, setConsent] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [issued, setIssued] = useState<(AgentGrant & { token: string }) | null>(null), [copied, setCopied] = useState(false);
  const childId = child?.id;
  async function load() {
    const [family, patient, info] = await Promise.all([api.familyAgentGrants(), childId ? api.agentGrants(childId) : Promise.resolve({ grants: [] }), api.connectionInfo()]);
    return { grants: [...family.grants, ...patient.grants], endpoint: info.endpoint };
  }
  useEffect(() => { let cancelled = false; load().then(data => { if (!cancelled) { setGrants(data.grants); setEndpoint(data.endpoint); } }).catch(error => { if (!cancelled) setError(message(error)); }); return () => { cancelled = true; }; }, [childId]);
  async function reload() { setError(""); try { const data = await load(); setGrants(data.grants); setEndpoint(data.endpoint); } catch (error) { setError(message(error)); } }
  function changeAccess(value: "family" | "patient") { setAccess(value); setScopes(value === "family" ? [...usualScopes] : [...patientScopes]); setConsent(false); setIssued(null); setCopied(false); }
  async function create(event: FormEvent) {
    event.preventDefault(); if (!consent || !scopes.length || pending) return;
    setPending(true); setError(""); setIssued(null); setCopied(false);
    try {
      const input = { name: name.trim(), days, scopes, consent: true as const };
      const response = access === "family" ? await api.createFamilyAgentGrant(input) : childId ? await api.createAgentGrant(childId, input) : null;
      if (!response) throw new Error("请先选择一个患者档案。");
      const { token, ...grant } = response.grant; setIssued({ ...grant, token }); setGrants(list => [grant, ...(list ?? [])]); setConsent(false);
    } catch (error) { setError(message(error)); } finally { setPending(false); }
  }
  async function revoke(grant: AgentGrant) {
    setPending(true); setError("");
    try {
      if (grant.childId) await api.revokeAgentGrant(grant.childId, grant.id); else await api.revokeFamilyAgentGrant(grant.id);
      if (issued?.id === grant.id) setIssued(null);
      setGrants(list => list?.map(item => item.id === grant.id ? { ...item, revokedAt: new Date().toISOString() } : item) ?? null);
    } catch (error) { setError(message(error)); } finally { setPending(false); }
  }
  const pack = issued ? connectionPackage(endpoint, issued) : "";
  async function copy() { if (!pack) return; try { await navigator.clipboard.writeText(pack); setCopied(true); } catch { setError("复制未完成。请选中下面整段连接包，手动复制后粘贴到你的专属智能体。"); } }
  const allowed = access === "patient" ? patientScopes : agentScopes.filter(scope => scope !== "invites:write" || user.role === "admin");
  return <>
    <div className="page-heading"><div><h1>连接 Octop 智能体</h1><p>把专属连接包发给已安装病程本插件的智能体，绑定后即可对话维护。</p></div><Plug size={24} aria-hidden="true" /></div>
    <ErrorNotice error={error} retry={() => void reload()} />
    <section className="paper form-panel"><h2>生成凭据和使用说明</h2><p className="subtle">家庭连接可管理本账号现有及今后新建的本人、孩子档案，不需要先建档。确认记录、删除和分享前，智能体应先向你核对；能力受下方权限限制。</p>
      <form onSubmit={create}><div className="form-grid">
        <Field label="连接范围"><select value={access} disabled={pending} onChange={event => changeAccess(event.target.value as "family" | "patient")}><option value="family">本人和孩子 · 账号维护连接</option><option value="patient" disabled={!child}>仅 {child?.nickname ?? "指定患者"} · 草稿录入连接</option></select></Field>
        <Field label="连接名称"><input required maxLength={120} disabled={pending} value={name} onChange={event => setName(event.target.value)} /></Field>
        <Field label="有效天数"><input type="number" required min={1} max={90} disabled={pending} value={days} onChange={event => setDays(Number(event.target.value))} /></Field>
      </div>
        <details><summary>查看与调整权限（{scopes.length} 项）</summary><fieldset className="scope-fields"><legend>允许智能体执行的操作</legend>{allowed.map(scope => <label className="checkbox" key={scope}><input type="checkbox" disabled={pending} checked={scopes.includes(scope)} onChange={event => { setScopes(list => event.target.checked ? [...list, scope] : list.filter(item => item !== scope)); setConsent(false); }} /><span>{scopeNames[scope]}</span></label>)}</fieldset></details>
        <label className="checkbox"><input type="checkbox" required disabled={pending} checked={consent} onChange={event => setConsent(event.target.checked)} /><span>我同意上述范围的资料可被我使用的智能体读取和维护。我会将连接包仅发给自己的可信智能体，不放入公共专家、共享连接器或群聊。</span></label>
        <Button type="submit" pending={pending} disabled={!consent || !scopes.length || grants === null || !endpoint}><ShieldCheck size={16} />生成我的连接包</Button>
      </form>
      {issued && <div className="share-result" role="status"><h3>整段复制，发给你的智能体</h3><p>包含地址、凭据、权限、到期时间和操作说明。凭据只显示这一次，拥有它就能执行已授权的操作。</p><Field label="Octop 连接包"><textarea aria-label="Octop 连接包" className="connection-package" readOnly rows={14} value={pack} onFocus={event => event.target.select()} spellCheck={false} /></Field><div className="actions"><Button onClick={() => void copy()}><Copy size={16} />{copied ? "连接包已复制" : "复制凭据和说明"}</Button><button className="secondary" onClick={() => { setIssued(null); setCopied(false); }}>隐藏连接包</button></div><p className="subtle">不会写入浏览器存储。离开此页后不再显示；遗失后可撤销并重新生成。无需向智能体发送登录密码。</p></div>}
    </section>
    <section className="paper"><h2>粘贴之后如何确认连通</h2><p>插件先验证凭据，实际调用 <code>get_connection</code> 返回你的账号与权限，再绑定到你在 Octop 中的专属身份。验证成功后，即可让智能体查看或维护档案。</p><Field label="插件调用地址 · Streamable HTTP"><input readOnly value={endpoint} /></Field><p className="subtle">{endpoint.startsWith("https:") ? "当前是公网 HTTPS 入口，远程插件可使用此地址；管理员电脑和隧道需在线。" : "当前显示本机地址，远程插件无法直接访问。请从管理员提供的公网 HTTPS 地址登录后生成连接包。"} 插件由部署者预先安装，家长只需发送连接包。插件不可把不同用户的凭据保存在同一个共享连接中。</p></section>
    <section className="paper"><h2>专属连接与撤销</h2>{grants === null ? !error && <Loading /> : grants.length ? <div className="share-list">{grants.map(grant => { const expired = Date.parse(grant.expiresAt) <= Date.now(); return <div className="share-row" key={grant.id}><div><strong>{grant.name} · {grant.revokedAt ? "已撤销" : expired ? "已到期" : "有效"}</strong><small>{grant.access === "family" ? "本人和孩子 · 账号连接" : "指定患者 · 草稿连接"}</small><small>{grant.scopes.map(scope => scopeNames[scope]).join("；")}</small><small>到期：{new Date(grant.expiresAt).toLocaleString("zh-CN")} · 最近使用：{grant.lastUsedAt ? new Date(grant.lastUsedAt).toLocaleString("zh-CN") : "尚未使用"}</small></div>{!grant.revokedAt && !expired && <Button pending={pending} className="secondary" onClick={() => void revoke(grant)}>撤销连接</Button>}</div>; })}</div> : <Empty title="还没有智能体连接">生成一个专属连接包，再发给已安装插件的智能体。资料仍保存在同一个病程本中。</Empty>}</section>
  </>;
}

export function MedicalSummaryView({ child }: { child: Child }) {
  const [data, setData] = useState<{ summary: MedicalSummary; markdown: string } | null>(null), [error, setError] = useState("");
  useEffect(() => { let cancelled = false; api.medicalSummary(child.id).then(value => { if (!cancelled) setData(value); }).catch(error => { if (!cancelled) setError(message(error)); }); return () => { cancelled = true; }; }, [child.id]);
  async function reload() { setError(""); try { setData(await api.medicalSummary(child.id)); } catch (error) { setError(message(error)); } }
  function download() {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data.markdown], { type: "text/markdown;charset=utf-8" })), link = document.createElement("a");
    link.href = url; link.download = "就诊摘要-" + child.nickname.replace(/[\\/:*?"<>|]/g, "_") + ".md"; link.click(); URL.revokeObjectURL(url);
  }
  return <><div className="page-heading"><div><h1>就诊资料摘要</h1><p>{child.nickname} · 按病历式段落整理，保留原始来源</p></div><div className="heading-actions"><button className="secondary" onClick={() => void reload()}>刷新摘要</button><Button disabled={!data} onClick={download}><Download size={16} />下载摘要</Button></div></div><ErrorNotice error={error} retry={() => void reload()} />{!data ? !error && <Loading /> : <><p className="notice">{data.summary.notice} · 有 {data.summary.excludedDrafts} 条待核对记录未纳入。</p><section className="paper"><h2>基本资料</h2><p>代称：{child.nickname} · 出生年：{child.birthYear ?? "未记录"}</p><p>档案诊断（原记录）：{child.diagnosis || "未记录"}</p></section><section className="paper medical-sections">{data.summary.sections.map(section => <section key={section.key}><h2>{section.label}</h2>{section.entries.length ? section.entries.map(entry => <div className="summary-entry" key={entry.recordId}><p className="pre-wrap">{entry.text}</p><small className="subtle">{entry.occurredOn} · {entry.source} · 版本 {entry.version}<span className="mono">{entry.recordId}</span></small></div>) : <p className="subtle">未记录</p>}</section>)}</section><section className="paper"><h2>检验与病程记录</h2>{data.summary.timeline.length ? data.summary.timeline.map(record => <article className="summary-entry" key={record.recordId}><h3>{record.occurredOn} {record.title}</h3><p className="pre-wrap">{record.notes || "未填写说明"}</p>{record.measurements.map(item => <p key={item.code}>{item.label}：<strong>{item.value}</strong> {item.unit}</p>)}<small className="subtle">来源：{record.source} · 时区：{record.timezone} · 版本 {record.version}</small></article>) : <Empty title="还没有已核对记录">先核对病程时间线中的草稿，再生成摘要。</Empty>}</section></>}</>;
}
