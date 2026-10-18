# 数据流与契约

2026-10-19 归档补充：[智能体初始模板](../octop/agent-template/)、[插件安装与权限](../octop/README.md)、[公开路演材料](presentation/README.md)。模板不导出实际用户记忆，演示素材不代替设备或临床验收。

## 手机采样

`MR11 → Android RingService / EfeProtocol → LocalStore 队列 → RemoteApi → /api/dravet/* → 独立监测 SQLite`

BLE 在 Android 前台服务中采集；历史与即时来源分开。配对凭据由 Android Keystore 加密，服务端授予独立手机上传权限。批次具有稳定 ID，服务端确认后才出队；失败保留队列并显示错误。采样的单位、质量、设备时间与手机接收时间分别保存，未经验证不互相替代。

## 家长病程

`family-web → 家长会话 / CSRF → /api/family/* → 归属与版本校验 → 病程 SQLite / 加密附件`

SQLite 是唯一事实来源。检验、症状、用药和就诊先保存草稿，核对当前版本后才进入摘要；修订保留历史。账号管理员没有读取其他家庭病程的权限。分享只暴露有效授权范围内的已核对摘要，可到期与撤销。

## 智能体协作

`Octop 可信用户上下文 → 插件每用户加密绑定 → 可撤销 MCP 授权 → 同一服务端领域校验`

家庭插件按 scope 提供病程读写，敏感操作先预览并取得明确确认；Dravet 插件仅查询单患者的五个只读工具。模型不能传入用户身份、变更 scope、选择任意服务地址或控制戒指。手机凭据不能用于智能体查询，智能体只读授权不能上传。

窗口查询采用明确时区、最多七天和显式截断。measured / replay / synthetic 来源分组，缺项、未知质量与采样空窗不能解释为正常或安全。病程与监测分别保存密钥和数据库，备份时必须一起保留各自完整数据集。

权威接口见 `server/src/dravet/contracts.ts`、`server/src/server/validation.ts` 与 `server/src/shared/types.ts`；详细文档见 [服务端](../server/README.md)。旧 FastAPI / PostgreSQL / Hermes worker 不再是当前运行架构。

## 待验证能力

真实 MR11 配对、Android WebView 登录与会话保持、整夜 BLE 覆盖、断网补传及端侧响铃仍需实机验收。服务端只记录观察与提醒事件，不执行医学规则、推送或设备控制；技术测试不证明癫痫识别或临床预警有效性。
