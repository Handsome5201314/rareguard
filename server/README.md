# 病程本独立服务端

Node.js 24 / TypeScript 后端，SQLite 是病程的事实来源。`src/server/` 管理账户、档案、记录、加密附件、版本、授权与审计；`src/dravet/` 管理独立监测库、手机配对／上传、只读 MCP 和内置 `/dravet` 管理页。前端位于同仓库 [family-web](../family-web/README.md)，Octop 插件位于 [plugins](../plugins/README.md)。

## 独立运行

在本目录执行：

```sh
npm ci
npm run build
npm start
```

默认仅监听 `127.0.0.1:7870`；`GET /healthz` 用于技术健康检查。API-only 模式下 `/` 返回明确的 404，内置 `/dravet` 可用。需要家长网页时，在仓库根目录按 [前端说明](../family-web/README.md) 构建和启动；也可在本目录执行 `npm start -- --web-root ../family-web/dist`。

| 配置 | 行为 |
| --- | --- |
| `FAMILY_PORT` | 默认 7870，有效范围 1–65535 |
| `FAMILY_DATA_DIR` | 默认启动工作目录下的 `family-data`；建议部署时指定绝对路径 |
| `FAMILY_WEB_ROOT` | 未配置则 API-only；网页构建目录须含 index.html，命令行优先 |
| `FAMILY_PUBLIC_ORIGIN` / `FAMILY_PROXY_TOKEN` | 可信 HTTPS 反代配置，必须配套；不能代替用户授权 |
| `FAMILY_AGENT_TOKEN` | 仅 stdio MCP，使用网页单独生成的可撤销授权 |

相对目录按启动工作目录解析。HTTP 入口只在当前工作目录加载 `.env.family-public`（如存在），环境变量优先；不会向父目录查找数据。配置字段参考 [.env.example](.env.example)。不要在已有正式实例占用端口或操作数据库时启动第二个写入进程。

## 接口与权限

- `/api/family/*`：家长会话、CSRF、档案归属、邀请注册、草稿与核对、修订历史、私有附件、可撤销分享。
- `/mcp/family`：Streamable HTTP；家庭连接 30 工具，原单患者连接 9 工具，按 scope 限制。确认、删除和分享需要可信用户明确指示。
- `/api/dravet/*`：家庭会话负责配对和授权，手机独立上传凭据负责批次与事件；稳定批次 ID、整批回滚、重传冲突可观察。
- `/mcp/dravet`：单患者 5 个只读工具；不继承家庭授权，不控制设备、不执行医学判断。
- `/dravet`：监测授权、时间窗、趋势、来源分组及事件时间线。
- `npm run mcp`：stdio MCP，显式指定数据目录与专用授权。

契约见 [CONTRACT](docs/CONTRACT.md)、[OCTOP](docs/OCTOP.md)、[PLUGIN-CONTRACT](docs/PLUGIN-CONTRACT.md) 和 [Dravet 集成](docs/DRAVET-INTEGRATION.md)。评分核心是独立版本快照，来源与更新规则见 [ASSESSMENT-SNAPSHOT](docs/ASSESSMENT-SNAPSHOT.md)。

## 备份与恢复

先停止负责服务的监督器及服务进程，确认端口释放，再完整复制 `FAMILY_DATA_DIR`。数据库、`key.bin`、加密 `attachments/` 以及存在的 WAL / SHM 必须作为同一数据集保存；若已有 `dravet/`，其独立密钥、SQLite 和 WAL / SHM 也一起保存。不能仅备份 JSON 导出或重建密钥。

恢复到新的目录，使用绝对 `FAMILY_DATA_DIR` 启动，核对账户、档案、版本和附件下载后再切换。保留原备份；不要让两个实例同时操作一份目录。运行中升级或回滚需要先保留完整旧数据与匹配代码，不由本仓库自动操作现网。

## 验证

```sh
npm run typecheck
npm test
```

测试使用临时目录与合成资料，覆盖 SQLite、真实 HTTP / MCP、归属和角色隔离、scope、撤销、幂等、版本、CSRF、附件、迁移、时间窗与设备授权。历史 2026-10-15 验证为 92/92，记录见 [集成说明](docs/DRAVET-INTEGRATION.md)；本次同步验证另记于 [publication](../docs/publication.md)。

当前没有临床预警、医师签署、账户找回／注销或物理擦除；逻辑删除保留历史。技术测试不证明临床有效性。
