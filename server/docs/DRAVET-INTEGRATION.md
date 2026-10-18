# Dravet × 病程本 × Octop 接入说明

更新：2026-10-15。面向维护服务端、Octop 与 Android 的开发者。

首版已于 2026-10-15 正式切换上线：同一个病程 HTTP 服务提供监测接收、独立监测存储、家长管理页及只读 MCP；Android 上传不再依赖 Hermes，Octop 通过独立插件读取监测数据。继续使用原病程数据目录，账号、档案、记录、附件及原密钥的维护核对通过；没有迁入患者测试数据。手机/戒指及绑定后的真实对话尚未联调。

正确 APP 源工程为仓库内的 `../app`。它保留真实 MR11 EFE BLE、本机记录和本地实验提醒，新增病程手机上传队列及 Octop/病程内嵌网页。外部厂商 Demo 仅作 SDK 参考，不是 APK 源工程；其本轮误加的病程模块和 APK 已移除并留有可恢复备份。当前 APP 版本为 `0.3.0+3`，release 为沿用 debug 签名的测试包。

服务切换、家长网页和 Octop 插件状态保持前述正式发布结果。真实手机配对、绑定后的对话、MR11/整夜采集仍需真机验收，不能用旧 Demo 的截图或测试结论代替。

## 1. 数据流与模块边界

```text
真实 SDK 回调 → Android 加密离线队列 → HTTPS /api/dravet/*
                                              ↓
病程 FamilyStore（账户/患者/归属） ← 验证 → DravetStore（监测独立库）
                                              ↑
家长 /dravet 管理授权与查询          /mcp/dravet ← Octop 只读插件
```

- `src/server/http.ts` 组合既有病程处理器与 `src/dravet/`，继续使用同一回环监听端口、Host/Origin、可信反代和家长 CSRF 校验；没有另开公网端口。
- `FamilyStore` 是账户、患者档案及归属的唯一事实来源。Dravet 不创建另一套账户，不按姓名匹配患者；患者删除或归属无效时旧凭据不能继续使用。
- `${FAMILY_DATA_DIR}/dravet/` 包含 `dravet.sqlite`、独立 `key.bin` 及运行时可能存在的 WAL/SHM。采样值、设备说明、事件正文与授权详情使用 AES-256-GCM 加密；UUID、时间、信号类型、来源和质量等查询索引元数据不是整库加密。已有库丢失/使用错误密钥会拒绝打开，不生成替代密钥覆盖旧数据。
- 原 `/api/family/*`、`/mcp/family`、账号级家庭 30 工具、旧单患者 9 工具及原连接包保持原权限。高频监测数据不塞进手录病程事件，也没有自动写回“临床确认”记录。
- 家长网页 `/dravet` 和 `/dravet/app.js` 随服务端提供；API-only 模式也能使用。原 React 家长端导航增加“夜间监测”入口；API-only 的 `/` 仍返回 404，监测页不会显示无效的返回链接。
- `/dravet` 内置夜间数据工作台：家长可按患者、最近 6/12/24 小时或自定义时间窗浏览采样；按单一指标查看离散趋势（长空窗会断开），并同时查看最新读数、信号/来源分组、质量未知/较差、最大空窗和事件时间线。选择“全部指标”时仅显示总览，避免把 bpm、%、°C 等不同单位画在同一坐标轴上。工作台只读取当前账户拥有患者的已上传数据，不改变手机配对、Octop 只读授权或数据保留规则。

## 2. 家长使用流程

1. 服务切换到本版本并配置既有 HTTPS 公网 origin 后，打开 `/dravet`，用已有病程账户登录并选择患者。没有档案时先在原病程端建档。
2. 填写采集手机名称、硬件型号和协议，明确同意后生成五分钟 APP 配对包。连接包仅当次显示，切换患者或点击隐藏会清除显示，不存进浏览器持久存储。
3. 在 RareGuard APP 的“我的 → 服务与隐私”粘贴完整包并授权；APP 只允许当前已连接的戒指绑定。上传状态、待传条目和失败原因在该页显示。
4. 在 `/dravet` 为当前患者单独生成 Octop 只读连接包，设置 1–30 天期限；APP 的“家庭助手”页内嵌打开 Octop，使用自己的 Octop 账号登录后，将包发给已启用 Dravet 插件的智能体私聊以绑定。病程账号和 Octop 账号分别登录，网页不会自动授予监测权限。
5. 选择明确时间窗查询采样、事件与摘要。无记录会显示为空，不补“正常”、连续曲线或风险判断。
6. 到期后若手机仍有未传记录，在原设备行点击“更新手机授权”，用新包续期。撤销手机或智能体授权在网页完成；插件解绑和 APP 解除配对仅清除本地绑定，不代替服务端撤销。

## 3. 身份、凭据与续期

| 用途 | 凭据 | 权限与有效期 |
| --- | --- | --- |
| 家长管理 | 原病程 session cookie；写入附 `X-CSRF-Token` | 只能操作自己的患者 |
| 一次配对 | `dp_` 前缀，32 随机字节 | 五分钟、一次兑换；只能兑换手机上传凭据 |
| 手机上传 | `dd_` 前缀，32 随机字节 | 单患者、单采集手机，`monitoring:upload`，30 天 |
| 智能体查询 | `da_` 前缀，32 随机字节 | 单患者，`monitoring:read`，1–30 天 |

三类接入凭据和原病程 MCP 凭据不可互用。上传请求不接受客户端指定 ownerId/patientId；MCP 查询身份同样只由服务端验证的 Bearer 决定。设备列表中的登记状态不能作为当前 BLE 在线证据。

APP 包为以下六字段，示例值都是占位符：

```json
{
  "kind": "dravet-device-pairing",
  "version": 1,
  "url": "https://bingcheng.tongyimoheai.top",
  "pairingCode": "<一次性配对码>",
  "deviceId": "<采集手机UUID>",
  "patientId": "<患者UUID>"
}
```

Octop 包为独立的四字段格式：

```json
{
  "kind": "dravet-monitor-connection",
  "version": 1,
  "url": "https://bingcheng.tongyimoheai.top/mcp/dravet",
  "token": "<单患者只读凭据>"
}
```

Android 和插件固定接受上述 HTTPS origin，不跟随重定向。插件也不使用代理环境变量。本机隔离服务生成的 HTTP 包仅供接口测试，不能直接粘贴到发布的 APP 或插件使用。

**续期契约：** `POST /api/dravet/patients/:patientId/devices/:deviceId`，正文 `{ "consent": true }`，生成新五分钟配对包，保持原 deviceId/patientId。兑换成功时旧手机凭据被撤销，历史批次回执保留。APP 会核对包与服务响应的身份，并保留原戒指指纹、队列和幂等 ID；跨患者或跨设备重新关联会拒绝。已撤销设备不能续期。确需更换戒指/患者时，应先完成原队列同步，或由用户明确确认清除原未传记录，再建立新授权。

## 4. HTTP 接口参考

除手机接口与 MCP 外，以下接口均使用既有家长会话，写入要求 CSRF；所有患者路径均再次检查归属。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/dravet/patients/:patientId/devices` | 设备登记列表 |
| `POST /api/dravet/patients/:patientId/devices` | `{name,model,protocol,consent:true}`，创建一次配对 |
| `POST /api/dravet/patients/:patientId/devices/:deviceId` | 原设备续期，正文 `{consent:true}` |
| `DELETE /api/dravet/patients/:patientId/devices/:deviceId` | 撤销设备，失效其手机凭据及未兑包 |
| `GET /api/dravet/patients/:patientId/agent-grants` | 智能体授权列表，不返回 token |
| `POST /api/dravet/patients/:patientId/agent-grants` | `{name,days,consent:true}`，生成单患者只读包 |
| `DELETE /api/dravet/patients/:patientId/agent-grants/:grantId` | 撤销指定智能体授权 |
| `GET /api/dravet/patients/:patientId/samples?from=…&to=…&limit=…` | 查询采样 |
| `GET /api/dravet/patients/:patientId/events?from=…&to=…&limit=…` | 查询事件 |
| `GET /api/dravet/patients/:patientId/summary?from=…&to=…&limit=…` | 查询描述性摘要 |
| `POST /api/dravet/pair` | `{pairingCode}` 兑换；返回 deviceId/patientId/token/expiresAt |
| `POST /api/dravet/batches` | 手机 `Bearer dd_…`，提交 `{batchId,samples}` |
| `POST /api/dravet/events` | 手机 `Bearer dd_…`，提交单个事件 |
| `POST /mcp/dravet` | 智能体 `Bearer da_…`，Streamable HTTP MCP |

### 采样、时间与幂等

权威 Schema 为 `src/dravet/contracts.ts`。

- 每批 1–500 点，JSON/MCP 请求正文最多 512 KiB。采样含 UUID `id`、UUID `sessionId`、非负安全整数 `sequence`、`sampledAt`、`receivedAt`、`timeSource`、可空 `rawTimestamp`、`source`、`quality`、`kind`、`value`、`unit`，可选 64 位小写 hex `hardwareId`。
- 心率 `hr` 使用 `bpm`，血氧 `spo2` 使用 `%`，三轴 `acc` 为 `{x,y,z}`，单位只接受 `raw`、`g` 或 `m/s2`。`raw` 不推定为物理单位，更不能据此给出医学结论。
- 时间必须为含时区 ISO8601。`timeSource` 为 `device_verified` 或 `phone_received`；`source` 为 `measured/replay/synthetic`；`quality` 为 `good/poor/unknown`。服务不将回放、自检或未知质量自动变成真实/良好数据。
- 接受乱序。相同设备/批次 ID 内容相同返回既有回执，内容不同返回 409；相同样本 ID 或同设备/会话/序号/信号冲突也返回 409。事务整批回滚，不留下部分成功。回执含 `batchId/received/inserted/duplicates/committedAt`。
- `sampledAt`、`receivedAt` 或事件时间超出服务时钟五分钟会明确拒绝；不能以未来时间伪装补传。
- 查询采用 `[from,to)` 半开窗口，必须大于零且最多七天；limit 默认 500、范围 1–1000。采样和事件响应显式返回 `truncated`；截断时缩小窗口，不把限额当成完整结果。
- 摘要按设备/信号/来源汇总计数、首末时间、未知/差质量数量，最大间隔只在同设备/会话/信号/来源内计算；不计算临床风险或连续覆盖率。摘要中的事件列表同样受 limit 限制。

### 事件与报警边界

事件 Schema 包含 `id/sessionId/occurredAt/kind/source/relatedEventId/ruleVersion/note`。类型为连接、断线、采集失败、提醒请求、设备自报响铃、家长确认和观察。响铃及确认必须关联同设备、同会话、同来源的原始提醒请求。

**当前只记录事件，不执行医学规则、不触发声音/推送、不控制设备，也不把家长确认当成临床确认。** 确定性端侧报警及通知需要单独真实验收，不能依赖 Octop 或聊天可用性。

## 5. Octop 接入

源码位于 [Dravet 插件](../../plugins/dravet-monitor-plugin/README.md)，安装包由 `plugins/tests/package_dravet_plugin.py` 生成到被忽略的 `plugins/dist/`；详见 [插件构建说明](../../plugins/README.md)。现有病程插件不需要替换，两个插件各自管理自己的授权和加密绑定。

1. 本机已安装 0.1.0 并为 `NOA RareGuard｜Dravet 夜间监护项目助手`（`dravet-night-monitor`）启用，服务已重启加载。打开该专家的新会话；其他部署仍需在插件管理安装 ZIP 并为指定专家启用。
2. 将网页刚生成的夜间监测只读包发到自己的可信私聊；智能体使用 `dravet_bind` 完成绑定。不要发送手机上传包，不把 token 填入智能体系统提示词。
3. 使用 `dravet_status` 核对患者/授权，`dravet_tools` 获取真实 Schema，`dravet_request` 查询；`dravet_unbind` 仅解除当前用户的插件绑定。

远端工具仅有 `get_connection`、`list_devices`、`get_samples`、`get_events`、`get_night_summary` 五个只读工具。请求白名单不接受模型传入身份或 token。每次查询重新验证 token、患者、账号、scope 和撤销状态。

插件读取 Octop 注入的可信用户/来源/会话上下文；IM 私聊再核对 agent/channel/session_key，拒绝群聊和缺少可信身份的请求。共用同一 Octop 用户不能靠聊天昵称实现家庭隔离。凭据在插件私有目录以 Fernet 加密保存，Windows 限制 ACL；不输出原始凭据。本次只合并新增插件命名空间的专家开关，保留原配置；未发布知识库、配置 IM 通道或替用户绑定患者。

## 6. Android 接入现状

唯一 APK 源工程：仓库内的 `../app`。这是 Flutter + Android Java 原生服务工程，包名 `org.rareguard.rareguard`；外部厂商 Demo 仅保留 SDK 参考资料，不作为构建或交付入口。

- `RingService` 继续使用已核对的 MR11 EFE BLE 协议，实时心率/血氧、本机历史、事件观察和实验变化提醒保留在本机；历史数据不会被伪装成实时上传。
- v3 本地库为病程上传增加患者/服务端设备 scope、sessionId 和安全序号。旧 v2 样本、旧 outbox 和配对前事件保留但不回填新患者；跨患者或跨戒指换绑拒绝。只有配对后有效的实时 HR/SpO₂ 进入新队列，质量未知按 `unknown` 上传，无效值留本机。
- Android Keystore AES-GCM 保存 `dd_` 手机上传凭据；批次 1–200 点、稳定批次 ID、服务端确认后出队。网络失败、401、409 保留队列并显示错误，不默认成功。服务端事件接口只记录观察和提醒事件，不执行医学规则或远程推送。
- APP 的“夜间报告”打开病程管理网页；“家庭助手”打开 Octop 网页。WebView 仅允许 `bingcheng.tongyimoheai.top` 和 `octop.tongyimoheai.top` 的 HTTPS 默认端口，拒绝 userinfo、伪装域名、HTTP/file/content/intent/javascript、混合内容和证书错误；不注入 token、不提供 JS 原生桥、不控制 BLE。
- 当前测试 APK：`../app/build/app/outputs/flutter-apk/app-release.apk`，versionName `0.3.0`、versionCode `3`，SHA-256 `32A952433762D696F97D69672B8BF08A1D43E37E4C87FB08244700AD36B229BF`。它沿用工程现有 debug 签名，仅是 release 构建测试包，不是正式发布签名。
- 本轮验证：Flutter 流程测试 19 项、核心协议检查 35 项、实验规则检查 47 项、Android 原生单测通过；未连接真机。AndroidKeyStore/SQLite 恢复、真实 HTTPS 登录、绑定后的 Octop 对话、MR11/ACC、整夜 BLE 覆盖与端侧响铃仍需真机验收。

## 7. 已完成验证（2026-10-15）

| 范围 | 结果与边界 |
| --- | --- |
| 独立服务端 | 92/92：原 80 + 新 Dravet 12，真实 HTTP/SQLite/MCP；包含归属、角色隔离、撤销、续期、幂等/整批回滚、时间窗、事件关联、密钥与重开 |
| 新 Octop 插件 | 7/7：真实 Octop loader/ToolNode/MCP；ZIP 临时安装器验证后已安装生产实例。宿主实际工具策略核对：目标专家 5 工具、其他现有专家 0；重启后目标专家 running 且无运行错误。未执行真实患者绑定/对话 |
| 原 Octop 插件 | 14/14，既有病程权限与绑定回归 |
| 原评分工程 | 30/30，本轮重新执行通过 |
| Android | RareGuard `0.3.0+3`：Flutter 19 项、核心协议 35 项、实验规则 47 项、原生 Android 单测通过；release APK 构建成功；adb 未发现设备，未安装手机 |
| 原家长网页 | `npm run family:build` 类型检查和构建成功，导航已接入；本轮更新了 `family-web-dist` 构建产物 |
| 浏览器 | 临时合成账户/两个档案，配对、续期入口、只读包、切患者清凭据、无记录状态；1440×900 与 390×844 无横向溢出 |
| Octop 手机网页 | 真实 HTTPS 登录页在 390×844 下渲染，clientWidth/scrollWidth 均 390；没有提交登录或完成滑块，不等于 Android WebView/实际对话验收 |
| 正式发布 | 停服完整备份 8 个数据文件并逐个校验 SHA-256；病程维护计数、原密钥及附件一致，两库 quick_check 均 ok。12 项本机/公网 smoke 全过，包含新页面/脚本 200、匿名 REST/MCP 401、非法 Origin/代理 Host 403、Octop 健康 200 |

截图位于 Dravet 项目 `开发/验收/dravet-integration-desktop-20261015.jpg` 和 `dravet-integration-mobile-20261015.jpg`，只含合成数据且连接包已隐藏。测试结果不等于真实设备、真实专家或临床有效性验证。

Octop 手机网页截图为 `开发/验收/octop-login-mobile-20261015.png`，是浏览器入口验证，不能当成原生 APP 真机截图。

## 8. 正式发布与剩余验收

2026-10-15 已完成发布。公网入口为 `https://bingcheng.tongyimoheai.top/dravet`，继续使用 `mas-scoring-tool` 启动工作目录、其 `.env.family-public`、`family-data` 和 `family-web-dist`。唯一监听仍为本机 7870；计划任务 `AIYouth-FamilyOctop-Guardian` 已重启并运行独立后端，既有 Caddy/SSH 路径不变。Octop 的本机 8088 及公网健康检查也通过。

停服备份位于 `%LOCALAPPDATA%/AIYouthFamilyBackups/20261015-042203-dravet-release`，限制为当前用户、SYSTEM 和管理员访问；包括完整原病程目录、旧后端构建及原部署环境文件。原库 schemaVersion 保持 3，业务维护计数、原密钥及附件校验一致；新增 `dravet/` 独立空库及密钥，两库完整性检查通过。没有读取病例正文、创建正式测试患者或并行启动两个正式写入实例。前端构建此前已经更新，本次不声称保存了升级前的旧前端版本。

发布证据：Dravet 项目 `开发/验收/dravet-release-20261015.json`、`dravet-production-20261015.jpg`。原 `dravet-webview-20261015.json` 保留切换前检查历史，以发布报告为当前状态。

后续维护先确认实际监督器。只停 Node 会被守护自动拉起；本次使用核对动作路径后的 `Stop-ScheduledTask -TaskName 'AIYouth-FamilyOctop-Guardian'`，等端口释放后备份，再 `Start-ScheduledTask`。该任务同时管理 Octop 和两条隧道，停止期间会短暂中断它们。不得删掉原停止脚本的进程核验或按未知 PID 强杀；也不能把旧的、fresh=false 的守护状态文件当成当前状态。

剩余验收由家长选择患者并授权后进行：

1. 安装 RareGuard APP `0.3.0+3`，在“我的 → 服务与隐私”粘贴手机配对包并绑定；实测连接→HR/SpO₂→离线→重连补传→原设备续期，核对时间、来源、scope、幂等和撤销。
2. 打开现有 Dravet 专家新会话，发送单患者只读包，实测五个工具、撤销立即失败及 IM 私聊隔离。安装/启用通过不等于绑定后的真实对话通过。
3. 真机验证 WebView 登录/会话保持、KeyStore/SQLite 恢复，再验 MR11/ACC、整夜 BLE 覆盖与确定性端侧响铃。当前报警接口仅记录事件。

回滚前先停止监督器并另行完整备份升级后数据，避免覆盖新增记录；恢复代码、网页及完整数据需逐项确认版本匹配。不可只恢复某一个 SQLite 或重建密钥。技术发布、手机/专家端到端与医学安全验收分别记录。
