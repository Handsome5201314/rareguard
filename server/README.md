# 病程本独立服务端

本目录是病程本后端的唯一维护入口，从 `mas-scoring-tool/family/server`、`shared` 和 `tests` 拆出。具有自己的依赖锁、TypeScript 构建、HTTP/stdio 启动入口和测试，可单独复制、安装和运行，不要求旁边存在原评分工程、React 前端或 Octop。

Dravet 首版已在本工程集成：独立监测库、手机配对与补传、家长 `/dravet` 管理页和 Octop 只读 MCP。接入契约、Android/插件产物与正式切换边界见 [Dravet 集成说明](docs/DRAVET-INTEGRATION.md)。原有家长网页仍位于 `../mas-scoring-tool/family/web/`。

## 运行独立后端

需要 **Node.js 24 或更新版本**（内置 SQLite）。在此目录执行：

```powershell
Set-Location -LiteralPath '<repository>/server'
npm ci
npm run build
# 本机已有正式实例占用 7870，开发验证请使用另一个端口和独立空目录。
$env:FAMILY_PORT = '17890'
$env:FAMILY_DATA_DIR = 'family-test-data/manual'
npm start
```

未配置网页目录时为 API-only 模式，`/` 返回明确的 404，但内置 `/dravet` 管理页仍可使用；可通过 `/healthz` 检查服务。所有接口仍只监听回环地址，家长接口要求会话与 CSRF，MCP 要求单独的账号级或单患者 Bearer 授权。

需要同时托管家长网页时，先在原前端工程安装依赖并构建 `npm run family:build`，再显式指定目录：

```powershell
# 以下命令在 bingcheng-server 目录执行
$env:FAMILY_WEB_ROOT = '..\mas-scoring-tool\family-web-dist'
npm start
```

也可使用 `npm start -- --web-root <前端构建目录>`；命令行目录优先于环境变量。原前端工程的 `npm run family:start`、中文启动入口和后台守护已改为启动本工程的编译入口，并显式传入原网页目录。

## 配置与存储

| 配置 | 默认值／行为 |
| --- | --- |
| `FAMILY_PORT` | `7870`，有效范围 1–65535 |
| `FAMILY_DATA_DIR` | 启动工作目录下的 `family-data`；新目录会创建独立空库 |
| `FAMILY_WEB_ROOT` | 未配置则提供 API 与内置 `/dravet`；配置后须包含原家长网页构建好的 `index.html` |
| `FAMILY_PUBLIC_ORIGIN` | 既有 HTTPS 公网 origin；与代理密钥一起配置 |
| `FAMILY_PROXY_TOKEN` | 既有可信反代校验规则，不能用作家长或智能体授权 |
| `FAMILY_AGENT_TOKEN` | 仅 stdio MCP 使用，在网页内单独生成并可撤销 |

HTTP 入口会加载**当前启动工作目录**中的 `.env.family-public`（若存在），已设置的进程环境变量优先；不会向父目录搜索配置或正式数据。模板为 [.env.example](.env.example)，没有附带任何真实凭据。

**后端独立化及 Dravet 代码集成已完成，正式服务进程与数据目录没有切换。** 现有部署继续在原 `mas-scoring-tool` 工作目录启动，原 `.env.family-public`、`family-data`、`key.bin`、加密附件、端口和域名位置不变。下次通过已更新入口启动会使用新后端代码；不要在另一工作目录裸跑后误以为新空库是原库，也不要让两个进程同时操作正式库。本轮 `family:build` 已更新原 `family-web-dist`，静态产物与运行进程应分别核对。

以后确需迁移正式目录时，先停服并完整备份 SQLite、`key.bin`、附件及仍存在的 WAL/SHM，再用绝对 `FAMILY_DATA_DIR` 指向完整恢复目录。已有 `dravet/` 时，须一起备份其独立 `key.bin`、`dravet.sqlite` 和 WAL/SHM。备份与恢复步骤见 [原家长端说明](../mas-scoring-tool/family/README.md#完整备份与恢复)。不要单独迁库文件或重新生成原密钥。

## 模块边界

```text
bingcheng-server/
├── package.json / package-lock.json / tsconfig.json
├── src/
│   ├── server/                 # 病程领域、SQLite、HTTP、附件与 MCP
│   ├── dravet/                 # 监测协议、独立存储、手机接口、只读 MCP 与管理页
│   ├── shared/                 # 权威共享类型、连接包格式
│   └── internal-assessments/   # 独立运行所需的确定性评分核心快照
├── tests/                      # 真实 HTTP、SQLite、MCP、评分及启动验证
└── docs/
    ├── CONTRACT.md             # HTTP 与数据契约
    ├── OCTOP.md                # 智能体接入
    ├── PLUGIN-CONTRACT.md      # 账号绑定与工具安全约束
    ├── ASSESSMENT-SNAPSHOT.md  # 评分来源、版本与更新边界
    └── DRAVET-INTEGRATION.md   # 已实现接入契约、使用流程与验收边界
```

`src/server/store.ts` 是当前账户、患者归属、病程、版本、授权及审计的事实来源。网页与智能体复用同一领域校验。网页只引用 `src/shared` 的浏览器安全契约，不从原工程回引后端；旧 `family/server`、`family/shared`、`family/tests` 和 `tsconfig.family.json` 已移除，旧文档位置保留跳转。

评分核心来自原工程的内部快照，独立后端不再运行时引用 `../mas-scoring-tool/src`。快照来源和维护责任见 [说明](docs/ASSESSMENT-SNAPSHOT.md)；原无状态评分产品仍维护自己的版本，其独立安装和 Docker 构建依赖未增加本地包。

## 接口与验证

- `GET /healthz`：技术健康检查。
- `/api/family/*`：现有家长 HTTP 接口，路径及认证语义保留。
- `/mcp/family`：现有 Streamable HTTP MCP；家庭 30 工具，旧单患者 9 工具，权限不扩大。
- `/api/dravet/*`：家长授权/查询、一次配对和手机上传；家庭会话、手机上传凭据与智能体只读凭据分开。
- `/mcp/dravet`：单患者五个只读监测工具；不继承原家庭 MCP 授权。
- `/dravet`：内置夜间数据工作台和监测授权管理页，支持时间窗、单指标趋势、最新读数、信号/来源分组与事件时间线；原家长网页也提供导航入口。
- `npm run mcp`：stdio MCP，需显式提供数据目录与专用授权，协议输出不混入启动日志。

```powershell
npm run typecheck
npm test
```

拆分阶段验证：独立包 80 项测试（原病程 56、评分快照 19、部署配置与入口 5），原评分工程 30 项，以及真实 Octop 插件集成 14 项均通过；当时前端使用隔离构建。独立安装、生产依赖模式及启动入口记录见 [实施记录](docs/IMPLEMENTATION.md)。

2026-10-15 Dravet 增量验证：独立后端 92/92、新 Octop 插件 7/7、原插件 14/14、原评分 30/30；正式服务现已切换到独立后端，停服备份与原病程数据/密钥/附件核对通过，12 项公网/本机 smoke 全过。唯一 APK 源工程是仓库内的 `../app`：Flutter 19 项、核心协议 35 项、实验规则 47 项、原生 Android 单测和 `0.3.0+3` release 构建通过。厂商 Demo 仅为 SDK 参考，不是 APK 交付入口；真实 WebView 登录/对话、手机与 MR11、整夜采集及响铃尚未验收。完整结果与产物路径见 [Dravet 集成说明](docs/DRAVET-INTEGRATION.md#7-已完成验证2026-10-15)。

当前仍是资料记录产品：没有新增临床预警、医师签署、找回／注销或物理擦除能力；技术测试不代表临床有效性。
