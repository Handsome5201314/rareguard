# RareGuard 服务端

FastAPI + SQLAlchemy + PostgreSQL，接收 App 的真实即时测量、观察记录、实验提醒与监护人回执；生成夜间摘要，并可将已授权窗口的摘要交给 `dravet-night` Hermes profile。这是单家庭开发版本：家庭隔离、权限撤回、一次性配对码与控制台登录已经实现，医学规则与厂商推送尚未验证。

## 本地启动（Windows PowerShell）

需要 Python 3.12+、Docker Desktop；以下命令在本目录执行。PostgreSQL 必须使用独立开发实例，不能把生产地址放入测试配置。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

在本机 `.env` 填写 `RAREGUARD_LOCAL_POSTGRES_PASSWORD`。可以用下列命令生成并写入随机密码，命令不会输出密码：

```powershell
.\.venv\Scripts\python.exe -c "from pathlib import Path; import secrets; p=Path('.env'); p.write_text(p.read_text(encoding='utf-8').replace('RAREGUARD_LOCAL_POSTGRES_PASSWORD=', 'RAREGUARD_LOCAL_POSTGRES_PASSWORD='+secrets.token_hex(24), 1), encoding='utf-8')"
.\.venv\Scripts\python.exe scripts/local.py database
.\.venv\Scripts\python.exe scripts/local.py migrate
.\.venv\Scripts\python.exe scripts/local.py serve
```

API 监听 `127.0.0.1:18080`，开发数据库映射 `127.0.0.1:15438`。Docker 项目名为 `rareguard-development`，数据库使用独立 Docker volume；端口冲突时先调整 `compose.local.yaml` 和 `.env` 中的 `DATABASE_URL`。`GET /healthz` 是存活检查；`GET /internal/readyz` 是数据库/worker 就绪检查，反向代理应阻止公网访问 `/internal/*`。

`scripts/config.py` 只读取当前目录 `.env`、显式传入的路径或 `RAREGUARD_CONFIG_FILE`；环境变量优先。未创建 `.env` 时也可全部通过进程环境运行。`DATABASE_URL` 非空时按原样使用，未填写时由本地密码构造。Hermes 地址不会自动转换端口或主机名。

如要在 Docker 运行 API：先按上面迁移，然后执行 `.\.venv\Scripts\python.exe scripts/local.py compose`。容器内的 Hermes 地址必须从容器实际可达，例如 Windows Docker Desktop 的 `host.docker.internal`；地址由开发者显式配置。`compose.yaml` 不自动迁移数据库。

## 配对与控制台

App 凭证来自 10 分钟内有效的一次性配对码，服务端只保存 token/code 哈希。开发者可本地生成私有配对文件：

```powershell
.\.venv\Scripts\python.exe scripts/local.py -m server.admin --name "Developer" --output runtime/pairing.txt
```

在本机查看配对文件，把 code 输入自己的开发 App。第二位监护人使用 `--family <同一开发家庭 UUID>` 生成另一枚 code。配对后仍需分别同意上传、AI 分析与远程提醒；配对不自动授予这些权限。不要把 code、token、家庭 UUID 或配对文件提交到 GitHub。Unix 输出文件权限设为 `0600`；Windows 使用本机账户目录和合适的文件 ACL。

控制台使用独立登录：填写 `RAREGUARD_CONSOLE_USERNAME`、`RAREGUARD_CONSOLE_PASSWORD_HASH`、`RAREGUARD_CONSOLE_FAMILY_ID`，家庭 UUID 与开发配对文件一致。密码哈希格式为 `pbkdf2_sha256$310000$<hex salt>$<hex digest>`，digest 是 PBKDF2-HMAC-SHA256；密码应通过交互式输入或私有配置工具生成哈希，避免放进命令行、历史或日志。现网曾配置为同 Hermes Web 的账号密码，源码并不会强制共享，队友可独立设置。

Console cookie 始终包含 `Secure`、`SameSite=Strict`，登录写入还检查 Origin 与 CSRF。浏览器登录需可信 HTTPS 入口；不要通过关闭 Secure cookie 来规避。可配置本地 HTTPS 反代到 `127.0.0.1:18080`，然后把 `.env` 的 `RAREGUARD_CONSOLE_URL` 设为对应 `/console` URL，并重启服务。公网使用项目子域名，`/api/*` 去掉 `/api` 后转发，`/console` 保留原路径转发；`/api/internal/*` 和 `/api/console*` 应拒绝访问。仓库没有用户生产服务器的 DNS/SSH/Caddy 运维脚本。

## Hermes 配置

可选配置包括 `HERMES_BASE_URL`、`HERMES_API_KEY`、`HERMES_MODEL`、`HERMES_PROFILE` 与 `HERMES_WEB_URL`。`HERMES_BASE_URL` 是 profile 的 API 根地址，worker 在其后请求 `/v1/chat/completions`。默认建议模型/profile 为 `dravet-night`，实际返回的 model 必须与配置一致。

只有验证 profile 禁用工具与长期记忆、限制为已授权摘要后，才设置 `HERMES_RESTRICTED_CONTEXT_CONFIRMED=true`。未配置时问答返回可观察的 503；服务不会生成假回答。问答请求会携带授权窗口的摘要、观察与用户问题，因此只接入你有权限使用且接受此数据处理范围的服务。

## 隔离测试

测试只接受显式 `TEST_DATABASE_URL`：driver 必须是 `postgresql+psycopg`，host 只能是 `127.0.0.1`、`localhost` 或 `::1`，数据库名必须是 `rareguard_test`，且不能有 URL query 参数。测试不会从 `DATABASE_URL` 推导地址，也不会自行创建数据库；若该测试库内已有内容，fixture 会清除其表中数据。因此应使用临时 PostgreSQL 容器或专用测试实例，明确创建空测试库后填写 URL。

```powershell
# 此处已在独立本地 PostgreSQL 创建 rareguard_test，并在本机 .env 配置 TEST_DATABASE_URL。
.\.venv\Scripts\python.exe scripts/local.py test
```

测试数据全部为代码生成的合成 fixture，不需要真实戒指或真实 agent。包括原有 26 项 API/控制台/worker 检查、fresh-schema migration 回归，以及拒绝不安全测试连接的用例。迁移回归在随机空 schema 顺序运行 `0001`/`0002`，再逐级 downgrade，验证首次建库不会重复创建控制台表。

发布验证使用临时 Docker PostgreSQL，从全新数据库实际执行 `alembic upgrade head`，确认 revision 为 `0002 (head)`；37 项测试通过（原有 26 项 + 1 项迁移回归 + 10 项连接保护）。验证容器已清理。项目专用 `gateway_remote.py` 未纳入公共源码，因此原来的 `tests/test_gateway.py` 一并排除；不将生产运维检查混入通用服务测试。

## 配置与隐私边界

`.env.example` 所有凭据与家庭标识为空；真实 `.env`、`runtime/`、数据库、日志和虚拟环境全部忽略。不要提交真实生理数据、观察文本、问答记录、截图或导出文件。API 禁止记录健康 payload 和 Authorization，默认运行命令关闭 access log；部署时也应避免代理日志记录 token 或私密请求体。公开仓库保留现有公开业务 hostname 默认值；它不授予任何登录或读取权限。

测量字段保留来源、质量、单位与时间基准。质量未知和采样空窗不能得出安全结论；厂商血糖、血压、HRV 等数值不是已验证的临床指标。本服务不诊断癫痫、不提供用药或急救决策；App 目前以轮询获取提醒，不能视为已经验证的厂商后台推送。
