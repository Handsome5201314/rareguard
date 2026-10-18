# Dravet 夜间监测助手 0.1.0

在 Octop 插件管理安装 ZIP、给智能体启用，并开始新会话。家长登录病程本 `/dravet`，选定患者，生成只读连接包，在自己的可信私聊发送完整包，调用 `dravet_bind`。这与旧病程插件独立存储、独立授权，不自动扩大旧权限。

固定 MCP 地址为 `https://bingcheng.tongyimoheai.top/mcp/dravet`。不接受任意 URL、代理环境变量或重定向。`da_` 只读凭据不能上传；`dd_` 手机凭据不能绑定。每次查询实际验证有效期、撤销、家庭与患者归属。

五个 Octop 工具：`dravet_bind`、`dravet_status`、`dravet_tools`、`dravet_request`、`dravet_unbind`。远端五个工具为 `get_connection`、`list_devices`、`get_samples`、`get_events`、`get_night_summary`。查询窗口显式 from/to（ISO8601 含时区），最多七天；limit 1–1000，截断必须缩小窗口。来源 measured/replay/synthetic 分开呈现；phone_received 是手机收到时间，raw 加速度未标定，缺失不等于正常。不是诊断、风险判断或连续覆盖率。

建议智能体说明：用户发送夜间监测连接包时调用 dravet_bind，不复述或记忆凭据。后续先 dravet_status 和 dravet_tools，再按真实 Schema 使用 dravet_request。先与用户核对患者与时间窗；不向工具传用户身份，不推测时区、缺项或医学规则；错误如实说明。告警请求、设备自报响铃和家长确认分开，不作临床确认。

可信身份规则沿用现有病程插件：网页/CLI 由 Octop configurable.user/source/thread_id 注入；飞书和企业微信额外核对 agent_id、channel 和 session_key 私聊主体。群聊与缺少可信上下文时拒绝。共用一个 Octop 用户会共用绑定，不能用聊天名称隔离家庭。凭据使用 Fernet 加密到插件自己的私有目录；Windows 限制 ACL；可用 `DRAVET_PLUGIN_DATA_DIR` 指定绝对目录。

“解除夜间监测绑定”仅清除当前用户的插件绑定。服务撤销在 `/dravet` 完成。安装包和自动化测试不代表用户真实 Octop、通道或 MR11 已完成联调。
