# 病程本家长网页

React / Vite 客户端，连接同仓库 `server/` 的病程 HTTP API。家长可维护本人和孩子档案、记录检验／症状／用药／就诊、逐项核对、查看时间线／趋势／修订、保存私有附件、创建可撤销分享，以及生成 Octop 授权。

## 构建与运行

需要 Node.js 24。在仓库根目录执行：

```sh
npm --prefix server ci
npm --prefix server run build
npm --prefix family-web ci
npm --prefix family-web run build
npm --prefix family-web start
```

打开 http://127.0.0.1:7870。`start` 在 `family-web/` 工作目录启动后端，显式托管 `dist/`，默认创建本模块下被忽略的 `family-data/`；首次在本机注册管理员，之后通过邀请码加入。首次保存资料前需要明确同意。不要让两个进程打开同一份数据目录。

如 7870 已有服务，请在启动前设置不同的 `FAMILY_PORT`，并为 `FAMILY_DATA_DIR` 指定独立绝对路径。构建不会启动服务，也不会访问现有部署的数据。

开发时在另一个终端执行 `npm --prefix family-web run dev`，地址 http://127.0.0.1:5174，API 代理到本机 7870；后端仍须单独启动。共享类型仅来自 `../server/src/shared/`，无需原评分工程。

## 数据与操作边界

- 数据事实来源是服务端 SQLite；网页不保存另一套病程。记录先为草稿，用户核对当前版本后才能进入摘要；修订保留旧版本。
- 每个账户只能操作自己的档案。附件下载需要会话与归属检查；分享仅包含授权范围内的已核对摘要，可到期或撤销。
- 连接包只显示一次。只交给受信任的个人 Octop 会话；账号级家庭授权和单患者草稿授权的权限不同，均可撤销。
- 删除是逻辑删除，历史与审计仍保留。没有账户找回、注销、物理擦除或医生签署功能。
- 本网页不执行 OCR、模型推断或临床预警。未知、缺失或采样空窗不代表正常。

完整 API 见 [服务端契约](../server/docs/CONTRACT.md)，智能体接入见 [OCTOP](../server/docs/OCTOP.md) 和 [插件说明](../plugins/README.md)，来源说明见 [OPEN_SOURCE](OPEN_SOURCE.md)。完整备份必须停服后同时保存数据库、密钥和附件；详见 [服务端说明](../server/README.md)。
