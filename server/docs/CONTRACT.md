# 家长病程本 · 首版实现契约

本产品是独立 bingcheng-server 工程提供的本地服务，监听127.0.0.1:7870。旧公开评分服务不增加患者存储。SQLite与私有附件位于gitignored family-data/；默认不接任何云模型、不加载真实数据、不内置示例患者。使用Node24内置SQLite及已有TS/React/Vite/Zod。用户名密码，无邮件假认证；首位本地管理员，之后仅管理员生成的单次邀请码注册。临床风险不向家长展示。

共享类型是 src/shared/types.ts。服务端返回 JSON；成功包形状如下。失败统一 `{error:{code,message}}`，版本冲突409，未登录401，越权资源404，CSRF失败403。

## HTTP 接口

- GET /api/family/setup -> `{registrationOpen:boolean}`（仅零账户时true）
- POST /api/family/register `{username,displayName,password,inviteCode?,consent:true}` -> SessionInfo
- POST /api/family/login `{username,password}` -> SessionInfo
- GET /api/family/session -> SessionInfo
- POST /api/family/logout `{}` -> `{ok:true}`
- POST /api/family/invites `{}` -> Invite（仅admin；一次性，7天）
- GET /api/family/children -> `{children:Child[]}`
- POST /api/family/children ChildInput -> `{child:Child}`
- PATCH /api/family/children/:childId `{...ChildInput,expectedVersion:number}` -> `{child:Child}`；档案版本冲突409。
- GET /api/family/children/:childId/profile-revisions -> `{revisions:ProfileRevision[]}`；加密保存并回看档案历史。
- DELETE /api/family/children/:childId `{confirmation:string}` -> `{ok:true}`，按代称确认删除。
- GET /api/family/children/:childId/records -> `{records:HealthRecord[]}`（当前版本，发生时间倒序）
- POST /api/family/children/:childId/records RecordInput，Idempotency-Key请求头 -> `{record:HealthRecord}`
- PUT /api/family/children/:childId/records/:recordId `{...RecordInput,expectedVersion:number,reason:string}` -> `{record:HealthRecord}`，新版本必回draft。
- POST /api/family/children/:childId/records/:recordId/confirm `{expectedVersion:number,attestation:true}` -> `{record:HealthRecord}`
- DELETE /api/family/children/:childId/records/:recordId `{expectedVersion:number}` -> `{ok:true}`，保留历史及删除审计。
- GET /api/family/children/:childId/records/:recordId/revisions -> `{revisions:RecordRevision[]}`
- GET /api/family/children/:childId/attachments -> `{attachments:Attachment[]}`
- POST /api/family/children/:childId/attachments 原始文件body，Content-Type允许PDF/JPEG/PNG，X-Filename用encodeURIComponent -> `{attachment:Attachment}`；8MiB上限，检查文件签名。
- GET /api/family/children/:childId/attachments/:attachmentId -> 文件，鉴权+归属，Content-Disposition attachment，nosniff。
- DELETE /api/family/children/:childId/attachments/:attachmentId -> `{ok:true}`，仅未绑定文件可删除。
- GET /api/family/children/:childId/export -> `{formatVersion:1,child,records,revisions,attachments,exportedAt}`；不含凭据。
- GET /api/family/audit -> `{entries:AuditEntry[]}`；只看本人，不含数值病历。
- GET /api/family/children/:childId/shares -> `{shares:Share[]}`
- POST /api/family/children/:childId/shares `{hours:24|72|168}` -> `{share:Share}`（一次返回url，公开只读确认记录）
- DELETE /api/family/children/:childId/shares/:shareId -> `{ok:true}` 撤销
- GET /api/family/shared/:token -> SharedSummary（分享不含附件、来源或内部规则；记录notes保留需UI告知）
- POST /api/family/children/:childId/assessments `{scaleId,assessmentDate,recordIds:string[],context:object,clinical?:object}` -> `{assessment:AssessmentRun}`；仅本地admin且child.validationConsent=true，所选必须当前已确认版本且同日。上下文按量表原契约验证，不自动推断临床前提。
- GET /api/family/children/:childId/assessments -> `{assessments:AssessmentRun[]}`，同上权限；资料改动旧结果标stale。
- GET /api/family/connection-info -> `{endpoint:string}`；登录用户取得配置的公网或本机MCP地址。
- GET /api/family/agent-grants -> `{grants:AgentGrant[]}`；账号级家庭连接，不返回token。
- POST /api/family/agent-grants `{name,scopes,days,consent:true}` -> `{grant:AgentGrant & {token:string}}`；1–90天，一次返回明文凭据，可在无患者时创建。返回的 `grant.access` 为 `family`，不作为入参传入。
- DELETE /api/family/agent-grants/:grantId -> `{ok:true}`；撤销账号级连接。
- GET /api/family/children/:childId/agent-grants -> `{grants:AgentGrant[]}`；旧单患者列表，不返回token。
- POST /api/family/children/:childId/agent-grants `{name,scopes,days,consent:true}` -> `{grant:AgentGrant & {token:string}}`；旧3类scope、单患者连接，一次性明文创建。
- DELETE /api/family/children/:childId/agent-grants/:grantId -> `{ok:true}`；撤销旧单患者连接。
- GET /api/family/children/:childId/medical-summary -> {summary:MedicalSummary,markdown:string}；仅当前已确认记录。
- GET /healthz -> `{status:'ok',product:'family-timeline',storage:'sqlite',mode:'local-only'}`

## 安全和领域要求

写请求除登录注册外需同源Origin检查、HttpOnly SameSite=Strict会话Cookie与X-CSRF-Token。会话固定有效期7天，退出立即失效；不把token、密码或临床内容写日志。请求大小限制、登录速率限制。SQLite参数化查询、事务、foreign_keys、WAL；每个对象读取写入均按owner检查。发生日期必填，未知不补0、不同单位不合并图线，原值字符串保留。确认绑定版本，更改已确认记录重回draft且旧评估stale；时间精度用occurredOn+可空occurredTime+timezone保留。来源必填，lab至少1项。分享需要家长显式创建，到期/撤销失效，链接本身是访问凭证。没有医生认证，不使用clinician_verified。仅手录和附件，不编造OCR结果。

## 模块分工

store.ts负责数据库领域动作/身份/归属/版本/分享；http.ts负责真实HTTP、cookie/CSRF/文件/静态文件/原评分适配；web负责界面；tests覆盖真实存储和HTTP风险。导出和备份不同：JSON导出不能代替含附件和数据库的备份。

## 病历段落和智能体来源

RecordInput.clinical为可选对象，仅接受shared/types.ts中10个clinicalSections键，每段最多10000字符；缺项不补写，未知键拒绝。草稿核对界面对每个非空段落单独核对。clinical保留在修订和JSON导出中；公开限时分享沿用原PublicRecord字段，不自动公开新增病历段落或智能体sourceText。

HealthRecord.intake记录grantId、channel、messageId和sourceText，与病程payload共同加密。channel/messageId是来源标记，不是身份凭据。旧单患者连接的修订仅限本连接自己创建且仍为draft的记录；家庭连接获授records:manage后可按用户明确指示修订网页或其他连接创建的记录。新版本重新待核对，档案历史、修订历史和智能体操作留痕保留。

## MCP 契约

POST /mcp/family：官方SDK的无状态Streamable HTTP，12MiB请求上限；GET/DELETE405。HTTP需要专用Bearer，每工具检查授权；stdio使用FAMILY_AGENT_TOKEN。授权token数据库只存散列，默认不加载云模型。家庭授权绑定账号，调用时明确传本人或孩子 `patientId`；旧单患者授权绑定单个child。两者都检查撤销、到期、档案删除以及scope，不能使用模型传入的归属字段替代token身份。

工具及输入完整说明见[OCTOP.md](OCTOP.md) 与 [PLUGIN-CONTRACT.md](PLUGIN-CONTRACT.md)；tools/list为实际Schema。旧单患者连接发现9个工具，家庭连接额外发现账号与患者维护工具，共30个。get_connection不泄露诊断；get_intake_schema无患者内容。服务端仍按scope执行确认、删除、分享、导出和邀请，插件必须从可信会话取得明确确认。

成功返回content及structuredContent。执行错误返回isError:true与error.code/message，校验缺项可返回valid:false/issues。创建草稿的grantId+messageId幂等；精确重试返回原创建结果，改payload冲突。修订需要expectedVersion、reason和完整record。上传真实标准base64、不接受URL／路径，1字节–8MiB签名检查，与HTTP共用加密原件实现；上传不幂等，成功后复用附件ID。

数据库版本为3，自动迁移v1/v2授权、档案历史和幂等请求，保留旧记录、会话和手工幂等。升级前完整备份，回退用升级前备份。MCP不与旧公开评分服务混用。
