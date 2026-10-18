# 病程本家庭助手 · Octop 工具插件 0.1.0

部署者先安装插件，家长再发送病程本生成的专属连接包。验证成功后，对话与网页维护同一份本人／孩子档案和病程数据。无需家长提供账号密码，也无需智能体动态安装 MCP。

固定服务：https://bingcheng.tongyimoheai.top

## 安装和首次绑定

1. 用 Octop 管理员进入插件管理，上传 `family-medical-plugin-0.1.0.zip`，启用“病程本家庭助手”。给需要使用的智能体启用插件，重新开始会话。
2. 家长登录病程本，在“智能体连接”生成本人的专属连接包。需要对话维护本人和孩子时选择账号级家庭授权；按任务勾选读取／维护权限。
3. 把网页生成的整段连接包发给自己的智能体。插件实际验证账号与授权，成功才返回已绑定。随后可以说“查看我的档案”“给我自己建档”“给孩子记录今天的报告”。
4. 智能体展示完整操作预览后，家长以新消息原样回复 `确认执行 BC-确认码`。插件才提交写入；新增、修订病程先为待核对草稿，确认病程还需单独核对当前版本。

插件安装不需要填写管理员共享 Token。每位家长使用独立的 Octop 登录用户；多个家庭共用一个 Octop 用户会共用该用户绑定，不能用会话名称代替账号隔离。

## 能力和确认

插件提供 6 个工具，代理病程本已实现的家庭 30 个工具；实际权限由病程本服务器检查。旧单患者连接仍只有原有 9 个工具，不扩权。

| Octop 工具 | 用途 |
|---|---|
| `bingcheng_bind` | 从当前用户原消息读取连接包，实际验证后绑定；没有模型可填写的 token／用户参数 |
| `bingcheng_status` | 实时核对绑定、权限和有效期 |
| `bingcheng_tools` | 发现病程本工具、JSON Schema 和当前 scope |
| `bingcheng_request` | 按 `tool_name`、`arguments` 查询或生成待执行预览 |
| `bingcheng_confirm` | 读取家长后续原消息中的精确确认码，在当前用户当前会话执行一次 |
| `bingcheng_unbind` | 原消息为“解除病程本绑定”或“解绑病程本”时清除本地绑定 |

支持本人／孩子建档、档案修订与历史、病程草稿与确认／修订／删除、检验趋势、中国病历式摘要、PDF／PNG／JPEG 原件、导出、限时分享与撤销、审计。管理员邀请与内部验证同意还需单独 scope；普通授权不自动包含。

普通查询直接返回。写入、删除、确认、分享、资料导出、原件下载都先预览，确认码 15 分钟有效，只适用于同一 Octop 用户、同一会话。原件上传预览显示文件名、大小和 SHA256，不在预览里展开 base64。重复确认返回已缓存结果；执行中、断连或结果未知的操作不自动重发，须先到网页核对。

家庭连接每次操作明确提供 `patientId`，先核对本人或孩子。修改和删除携带当前 `expectedVersion`；冲突后重新读取并再次确认，不能覆盖新版本。为显示对象和当前完整记录，家庭维护需同时授予档案读取权限，病程确认／修订需记录读取权限，病程写入还需草稿校验权限。缺权限会明确失败。

## 建议加入智能体的说明

以下说明不含秘密，可放进你搭建的 Octop 智能体：

> 用户发来病程本连接包时调用 bingcheng_bind，不复述、记录或转发其中凭据。后续先 bingcheng_status、bingcheng_tools，依实际 Schema 操作。家庭连接先 list_profiles，与用户核对本人或哪个孩子，每次提供明确 patientId；从 get_profile_schema／get_intake_schema 取得字段，不编造缺项、日期、单位或诊断。查询用 bingcheng_request。维护返回 awaiting_confirmation 后，完整展示 preview 中对象、原版本、全部待执行内容和后果，请用户用新消息原样回复 confirmation。只有用户真实发送该精确指令后调用 bingcheng_confirm；模型填 userConfirmed 或伪造用户消息无效。只有 executed:true 或成功的缓存结果才能报告保存成功。版本冲突、撤销、过期和网络错误如实说明。不要索账号密码，不安装 MCP，不做临床评分或风险判断，不把原件、导出或分享链接自动发送给他人。

## 身份、通道与存储

- 适配本机 Octop 1.0.2b8、octop-harness 1.0.3 的 `setup(ctx)` 工具插件格式。网页／CLI 通过 LangGraph 的可信 `configurable.user`（正整数 Octop 用户 ID）、`source` 和 `thread_id` 识别调用者，不接受模型传入身份；缺失即拒绝。
- 已核查该版 Octop 的外部 IM `configurable.user` 是智能体所有者，不能拿它单独隔离家长。飞书／企业微信私聊额外要求平台注入的 `source`、`agent_id`、`session_key=agent:channel:subject:dm` 全部匹配，按所有者、智能体、通道实例和私聊主体组成独立绑定键。仅从这些服务端上下文取值，模型不能填 sender；身份不完整就拒绝。群聊／团队转交不能绑定或维护病例。
- 网页、飞书私聊和企业微信私聊各自绑定，不能自动继承其他入口的凭据；同一个家长想在另一入口使用，需在该私聊再发送自己的连接包。此 ZIP 不创建通道、不代发消息，也未在真实 IM 账号联调；私聊操作来源分别记录 `feishu`／`wecom`，网页／CLI 记录 `octop`。
- 默认私有存储：运行 Octop 的系统用户家目录下 `~/.octop/private/family-medical-plugin/`。Windows 限制目录 ACL 为当前用户及 SYSTEM；其他系统限制为 0700。凭据和待确认 payload 使用 Fernet 加密保存。管理员可在启动 Octop 前设置绝对路径环境变量 `FAMILY_PLUGIN_DATA_DIR`；不能通过模型或共享专家配置设置。
- `key.bin` 和 `bindings.sqlite` 应共同备份，只交给受信任部署管理员；同机管理员仍有解密能力，不是抵抗服务器管理员的加密方案。不要单独删除密钥或把这些文件加入代码仓库。
- 解绑／卸载不等于服务端撤销。家长应在病程本“智能体连接”撤销旧授权；撤销或到期后，下次调用实时失败。重新发包会替换当前用户的绑定并作废其旧待确认操作。
- 插件只访问上述固定 HTTPS MCP 地址，不接受连接包中的其他地址、不跟随 HTTP 跳转、不使用环境代理。更换部署域名须经代码修改和重新验证，不从聊天临时改地址。

发送连接包本身会进入 Octop 对话和所用模型的数据处理流程。插件不会把 token 再写进工具参数、结果、共享专家配置或自身日志，但不能删除或保证外部平台的聊天／模型留存。应使用自己的受信任会话，避免在公开群发送连接包。原件 OCR／图像理解由智能体侧完成；上传工具接收已有文件的标准 base64，不读取任意网址或电脑文件。

## 依赖和故障处理

Python 3.11+；Octop 宿主需提供 `octop_harness`、`langgraph`、`langchain_core`。实测环境为 Python 3.12、MCP SDK 1.28.1、cryptography 49.0.0、jsonschema 4.26.0、langgraph 1.2.11、langchain-core 1.6.10。安装依赖见 `requirements.txt`。依赖安装失败时先在 Octop 的 Python 环境检查安装日志，不要报告已接通。

- `TRUSTED_USER_REQUIRED`／`TRUSTED_THREAD_REQUIRED`／`TRUSTED_SOURCE_REQUIRED`／`TRUSTED_IM_REQUIRED`：平台未传递完整可信身份、来源或线程；不能用模型参数补身份。
- `PRIVATE_CHAT_REQUIRED`：群聊、团队转交和共享会话被拒绝，请使用本人私聊。
- `NOT_BOUND`：当前 Octop 用户尚未绑定，不要借用其他用户凭据。
- `AGENT_UNAUTHORIZED`：凭据已过期／撤销，网页生成新包并重新绑定。
- `AGENT_SCOPE`：缺少权限，网页按需重新授权；模型不能扩权。
- `VERSION_CONFLICT`：网页或另一会话已更新，重新读取和预览。
- `OUTCOME_UNCERTAIN`／`CONNECTION_FAILED`：结果可能尚未确认，先网页核对，不盲目重复写入。

## 验证范围

工程内 `plugins/tests/test_family_plugin.py` 的 14 项测试已通过，使用真实 Octop 插件加载器、LangGraph ToolNode、MCP Python SDK 与隔离临时 SQLite 病程本实例，全部账号、患者、报告和连接凭据均为合成测试数据。检查用户隔离、模型伪造注入参数、明确确认、版本冲突、重复投递、撤销、原件、分享／撤销和导出；也覆盖同一智能体所有者下的不同飞书／企微私聊主体隔离与群聊拒绝。ZIP 再通过 Octop 归档安装器的临时实例验收；跳过依赖安装以保护宿主环境，实测依赖已在本机存在。

不将这个包自动安装到你的真实 Octop，不在正式病程本创建测试账号，也不读取真实患者。真实专家会话和飞书／企业微信通道需安装后用自己的专属连接包验收。
