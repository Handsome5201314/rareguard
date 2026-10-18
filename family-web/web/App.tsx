import { useEffect, useRef, useState } from "react";
import { Activity, FileArchive, FileText, LogOut, Menu, Plus, Settings as SettingsIcon, Share2, SlidersHorizontal, UserRound, X, Plug, ClipboardList } from "lucide-react";
import type { Attachment, Child, HealthRecord, SessionInfo, Share } from "../../server/src/shared/types";
import { api, ApiError, message, setCsrfToken } from "./api";
import { Attachments, Auth, PublicSummary, Settings, Shares, Trends } from "./views";
import { AgentConnections, MedicalSummaryView } from "./integrations";
import { Button, ChildForm, Empty, ErrorNotice, Loading, RecordDetails, RecordForm, RecordList } from "./components";

type Page = "timeline" | "trends" | "attachments" | "shares" | "settings" | "connections" | "medical";
type Bundle = { childId: string; records: HealthRecord[]; attachments: Attachment[]; shares: Share[] };
const navItems: { page: Page; label: string; icon: typeof Activity }[] = [
  { page: "timeline", label: "病程时间线", icon: Activity },
  { page: "trends", label: "检验趋势", icon: SlidersHorizontal },
  { page: "attachments", label: "私有资料", icon: FileArchive },
  { page: "shares", label: "限时分享", icon: Share2 },
  { page: "medical", label: "就诊资料摘要", icon: ClipboardList },
  { page: "connections", label: "智能体连接", icon: Plug },
  { page: "settings", label: "账户与导出", icon: SettingsIcon },
];

function Timeline({ child, records, onAdd, onOpen, onEditChild, onRefresh }: {
  child: Child; records: HealthRecord[]; onAdd: () => void;
  onOpen: (record: HealthRecord) => void; onEditChild: () => void; onRefresh: () => void;
}) {
  const [kind, setKind] = useState("all"), [onlyDraft, setOnlyDraft] = useState(false);
  const filtered = records.filter(record => (kind === "all" || record.kind === kind) && (!onlyDraft || record.confirmation === "draft"));
  return <>
    <div className="page-heading">
      <div><h1>{child.nickname} 的病程时间线</h1><p>{child.diagnosis || "诊断未填写"} · {records.length} 条记录 · {records.filter(record => record.confirmation === "draft").length} 条待核对</p></div>
      <div className="heading-actions"><button className="secondary" onClick={onRefresh}>刷新记录</button><button className="secondary" onClick={onEditChild}>编辑档案</button><Button onClick={onAdd}><Plus size={16} />新增记录</Button></div>
    </div>
    <section className="toolbar">
      <label>种类<select value={kind} onChange={e => setKind(e.target.value)}><option value="all">全部</option><option value="lab">检验</option><option value="symptom">症状</option><option value="medication">用药</option><option value="visit">就诊</option></select></label>
      <label className="checkbox compact"><input type="checkbox" checked={onlyDraft} onChange={e => setOnlyDraft(e.target.checked)} /><span>只看待核对</span></label>
      <span className="subtle">按实际发生日期倒序</span>
    </section>
    <section className="paper timeline-paper">{filtered.length ? <RecordList records={filtered} onOpen={onOpen} /> : <Empty title={records.length ? "当前筛选没有记录" : "还没有病程记录"} action={records.length ? <button className="secondary" onClick={() => { setKind("all"); setOnlyDraft(false); }}>清除筛选</button> : <Button onClick={onAdd}><Plus size={16} />新增第一条记录</Button>}>{records.length ? "可以清除筛选，或切换种类查看。" : "从一次检验、症状、用药或就诊开始，保留发生日期、来源和原值。"}</Empty>}</section>
  </>;
}

export default function App() {
  const shareMatch = window.location.pathname.match(/^\/share\/([^/]+)$/);
  const [setup, setSetup] = useState<boolean | null>(null), [sessionReady, setSessionReady] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null), [authError, setAuthError] = useState("");
  const [children, setChildren] = useState<Child[]>([]), [childrenLoaded, setChildrenLoaded] = useState(false);
  const [childId, setChildId] = useState(""), [bundle, setBundle] = useState<Bundle | null>(null);
  const [page, setPage] = useState<Page>("timeline"), [editor, setEditor] = useState<"none" | "new-child" | "child" | "record">("none");
  const [selectedRecord, setSelectedRecord] = useState<HealthRecord | null>(null);
  const [childrenLoading, setChildrenLoading] = useState(false), [loading, setLoading] = useState(false), [dataError, setDataError] = useState("");
  const [mobileNav, setMobileNav] = useState(false), [logoutPending, setLogoutPending] = useState(false);
  const activeChild = useRef(childId), requestSequence = useRef(0);
  activeChild.current = childId;
  const child = children.find(item => item.id === childId);
  const data = bundle?.childId === childId ? bundle : null;

  useEffect(() => {
    if (shareMatch) return;
    let cancelled = false;
    api.setup().then(response => { if (!cancelled) setSetup(response.registrationOpen); }).catch(error => { if (!cancelled) setAuthError(message(error)); });
    api.session().then(response => { if (!cancelled) { setCsrfToken(response.csrfToken); setSession(response); } }).catch(error => { if (!cancelled && !(error instanceof ApiError && error.status === 401)) setAuthError(message(error)); }).finally(() => { if (!cancelled) setSessionReady(true); });
    return () => { cancelled = true; };
  }, [Boolean(shareMatch)]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setChildrenLoading(true); setDataError("");
    api.children().then(response => {
      if (!cancelled) { setChildren(response.children); setChildrenLoaded(true); setChildId(current => response.children.some(item => item.id === current) ? current : response.children[0]?.id ?? ""); }
    }).catch(error => { if (!cancelled) setDataError(message(error)); }).finally(() => { if (!cancelled) setChildrenLoading(false); });
    return () => { cancelled = true; };
  }, [session]);

  useEffect(() => {
    if (!session || !childId) { setBundle(null); setLoading(false); return; }
    const controller = new AbortController(), sequence = ++requestSequence.current;
    setLoading(true); setDataError("");
    Promise.all([api.records(childId, controller.signal), api.attachments(childId, controller.signal), api.shares(childId, controller.signal)]).then(([r, a, s]) => {
      if (!controller.signal.aborted && sequence === requestSequence.current) setBundle({ childId, records: r.records, attachments: a.attachments, shares: s.shares });
    }).catch(error => { if (!controller.signal.aborted && sequence === requestSequence.current) setDataError(message(error)); }).finally(() => { if (!controller.signal.aborted && sequence === requestSequence.current) setLoading(false); });
    return () => controller.abort();
  }, [session, childId]);

  async function reloadChild() {
    const id = activeChild.current;
    if (!id) return;
    const sequence = ++requestSequence.current;
    const [r, a, s] = await Promise.all([api.records(id), api.attachments(id), api.shares(id)]);
    if (activeChild.current === id && sequence === requestSequence.current) setBundle({ childId: id, records: r.records, attachments: a.attachments, shares: s.shares });
  }
  async function retry() {
    setDataError(""); setLoading(true);
    try {
      const response = await api.children(); setChildren(response.children); setChildrenLoaded(true);
      if (response.children.some(item => item.id === activeChild.current)) await reloadChild();
      else setChildId(response.children[0]?.id ?? "");
    } catch (error) { setDataError(message(error)); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    if (!session || editor !== "none" || page === "connections") return;
    let cancelled = false, pending = false;
    async function refresh() {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const response = await api.children(); if (cancelled) return;
        setChildren(response.children); setChildrenLoaded(true);
        if (!response.children.some(item => item.id === activeChild.current)) setChildId(response.children[0]?.id ?? "");
        else await reloadChild();
        if (!cancelled) setDataError("");
      } catch (error) { if (!cancelled) setDataError(message(error)); }
      finally { pending = false; }
    }
    const timer = window.setInterval(() => void refresh(), 20000);
    const onFocus = () => void refresh(); window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [session, editor, page, childId]);
  function signIn(next: SessionInfo) { ++requestSequence.current; activeChild.current = ""; setChildren([]); setChildrenLoaded(false); setChildId(""); setBundle(null); setSelectedRecord(null); setEditor("none"); setPage("timeline"); setDataError(""); setMobileNav(false); setCsrfToken(next.csrfToken); setSession(next); setAuthError(""); }
  function navigate(next: Page) { setPage(next); setSelectedRecord(null); setEditor("none"); setMobileNav(false); }
  function selectChild(id: string) { if (id !== activeChild.current) ++requestSequence.current; setChildId(id); activeChild.current = id; setSelectedRecord(null); setEditor("none"); setPage("timeline"); setMobileNav(false); setDataError(""); }
  function startChild() { setEditor("new-child"); setSelectedRecord(null); setMobileNav(false); }
  async function logout() {
    setLogoutPending(true); setDataError("");
    try {
      await api.logout(); ++requestSequence.current; activeChild.current = ""; setPage("timeline"); setMobileNav(false); setSession(null); setChildren([]); setChildrenLoaded(false); setBundle(null); setChildId(""); setSelectedRecord(null); setEditor("none"); setCsrfToken("");
    } catch (error) { setDataError(`退出未成功，请重试。${message(error)}`); }
    finally { setLogoutPending(false); }
  }
  async function saveChild(input: Parameters<typeof api.saveChild>[0], expectedVersion?: number) {
    const editing = editor === "child" ? childId : undefined;
    const requestedFromChild = activeChild.current;
    const response = await api.saveChild(input, editing, expectedVersion);
    setChildren(current => editing ? current.map(item => item.id === response.child.id ? response.child : item) : [...current, response.child]);
    if (activeChild.current === requestedFromChild) selectChild(response.child.id);
  }
  async function deleteChild(confirmation: string) {
    if (!child) return;
    await api.deleteChild(child.id, confirmation);
    const remaining = children.filter(item => item.id !== child.id);
    setChildren(remaining); selectChild(remaining[0]?.id ?? "");
  }
  async function saveRecord(input: Parameters<typeof api.saveRecord>[1], reason: string, idempotencyKey: string) {
    const id = childId;
    if (!id) return;
    const response = await api.saveRecord(id, input, selectedRecord ?? undefined, reason, idempotencyKey);
    if (activeChild.current !== id) return;
    setBundle(current => current?.childId === id ? { ...current, records: [...current.records.filter(record => record.id !== response.record.id), response.record].sort((a, b) => `${b.occurredOn}${b.occurredTime ?? ""}`.localeCompare(`${a.occurredOn}${a.occurredTime ?? ""}`)) } : current);
    setSelectedRecord(response.record); setEditor("none");
  }
  async function confirmRecord() {
    const id = childId;
    if (!id || !selectedRecord) return;
    const response = await api.confirm(id, selectedRecord);
    if (activeChild.current !== id) return;
    setBundle(current => current?.childId === id ? { ...current, records: current.records.map(record => record.id === response.record.id ? response.record : record) } : current);
    setSelectedRecord(response.record);
  }
  async function deleteRecord() {
    const id = childId, record = selectedRecord;
    if (!id || !record) return;
    await api.deleteRecord(id, record);
    if (activeChild.current !== id) return;
    setBundle(current => current?.childId === id ? { ...current, records: current.records.filter(item => item.id !== record.id) } : current);
    setSelectedRecord(null);
  }

  if (shareMatch) return <PublicSummary token={shareMatch[1]} />;
  if ((!sessionReady || setup === null) && !authError) return <div className="center-page"><Loading label="正在连接病程本…" /></div>;
  if (!session) return <><ErrorNotice error={authError} /><Auth registrationOpen={setup ?? false} onSession={signIn} /></>;
  let content;
  if (editor === "new-child" || editor === "child") content = <ChildForm key={editor === "new-child" ? "new" : `${childId}-${child?.version}`} child={editor === "child" ? child : undefined} onSave={saveChild} onReload={retry} onCancel={() => setEditor("none")} onDelete={editor === "child" ? deleteChild : undefined} />;
  else if (page === "connections") content = <AgentConnections key={childId} child={child} user={session.user} />;
  else if (childrenLoading || loading) content = <Loading label="正在载入患者资料…" />;
  else if (!childrenLoaded) content = <section className="paper"><p>档案尚未载入。请使用上方「重新载入」重试。</p></section>;
  else if (page === "settings") content = <Settings key={childId} session={session} child={child} />;
  else if (!child) content = <section className="paper"><Empty title="先建立本人或孩子档案" action={<Button onClick={startChild}><Plus size={16} />建立患者档案</Button>}>病程记录会按本人和孩子分别保存。可以使用代称，诊断与出生年可稍后补充。</Empty></section>;
  else if (!data) content = dataError ? <section className="paper"><p>患者资料尚未载入。请使用上方「重新载入」重试。</p></section> : <Loading />;
  else if (editor === "record") content = <RecordForm key={selectedRecord?.id ?? `new-${childId}`} original={selectedRecord ?? undefined} attachments={data.attachments} onSave={saveRecord} onCancel={() => setEditor("none")} />;
  else if (selectedRecord) content = <RecordDetails key={`${selectedRecord.id}-${selectedRecord.version}`} record={selectedRecord} attachments={data.attachments} onConfirm={confirmRecord} onEdit={() => setEditor("record")} onDelete={deleteRecord} onBack={() => setSelectedRecord(null)} />;
  else if (page === "timeline") content = <Timeline key={childId} child={child} records={data.records} onAdd={() => { setSelectedRecord(null); setEditor("record"); }} onOpen={setSelectedRecord} onEditChild={() => setEditor("child")} onRefresh={() => void retry()} />;
  else if (page === "medical") content = <MedicalSummaryView key={childId} child={child} />;
  else if (page === "trends") content = <Trends key={childId} records={data.records} />;
  else if (page === "attachments") content = <Attachments key={childId} child={child} attachments={data.attachments} records={data.records} reload={reloadChild} />;
  else content = <Shares key={childId} child={child} shares={data.shares} reload={reloadChild} />;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
      <div className="brand"><FileText size={22} /><span>病程本</span></div>
      <div className="child-picker"><label htmlFor="child-select">当前患者</label><div className="child-select-row"><select id="child-select" value={childId} onChange={e => selectChild(e.target.value)} disabled={!children.length}>{children.length ? children.map(item => <option key={item.id} value={item.id}>{item.nickname} · {item.relationship === "self" ? "本人" : "孩子"}</option>) : <option value="">还没有患者档案</option>}</select><button className="icon-button" aria-label="添加患者" title="添加患者" onClick={startChild}><Plus size={17} /></button></div></div>
      <nav aria-label="主导航">{navItems.map(item => { const Icon = item.icon; return <button key={item.page} aria-current={page === item.page ? "page" : undefined} className={page === item.page ? "active" : ""} onClick={() => navigate(item.page)}><Icon size={18} />{item.label}</button>; })}<button onClick={() => window.location.assign("/dravet")}><Activity size={18} />夜间监测</button></nav>
      <div className="sidebar-footer"><span className="user-chip"><UserRound size={15} />{session.user.displayName}</span><Button pending={logoutPending} onClick={() => void logout()}><LogOut size={16} />退出</Button><small>资料保存在服务管理员的电脑</small></div>
    </aside>
    <button className="mobile-menu" aria-expanded={mobileNav} aria-label={mobileNav ? "关闭导航" : "打开导航"} onClick={() => setMobileNav(value => !value)}>{mobileNav ? <X size={21} /> : <Menu size={21} />}</button>
    {mobileNav && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
    <main className="main-content" id="main-content"><ErrorNotice error={dataError} retry={() => void retry()} />{content}<footer className="workspace-footer">资料由用户记录与核对，不构成医疗建议。若患者出现急性不适，请及时联系医生或就医。</footer></main>
  </div>;
}
