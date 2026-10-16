# Octop 病程本插件接入契约

本文给 Octop 插件开发者使用。病程本只提供账号授权后的 MCP 服务；插件由部署者预先安装，病程本不动态安装 MCP，也不内嵌智能体。

## 用户流程

1. 用户登录病程本，在“智能体连接”生成账号级或单患者连接包。
2. 用户把整段连接包复制给自己的 Octop 智能体。
3. 已安装插件解析其中的 `kind`、`version`、`transport`、`url` 和 `headers`，通过插件自身的安全配置绑定。
4. 插件实际调用 `get_connection`，以服务端返回的 `account.id`、`grantId`、`access`、`scopes` 和 `expiresAt` 为准，再将这枚凭据绑定到 Octop 的可信用户身份。
5. 后续每次调用按已绑定用户取出独立 token；家庭连接先 `list_profiles`，让用户选定本人或孩子，再在每次写入传 `patientId`。

连接包是一次性秘密。插件不得把它写入公开提示词、共享连接器、日志、模型记忆或代码仓库，也不得把多个家庭保存到同一全局管理员连接。病程本没有登录密码接口，插件不应索要用户病程本密码。

## 插件边界

连接包里的地址和元数据都是用户提供的输入，不足以证明身份。插件应：

- 只允许部署者配置的固定 HTTPS origin（当前公网为 `https://bingcheng.tongyimoheai.top`），拒绝 `file:`, `data:`, 内网探测地址、跳转到其他 origin 和任意模型生成的 URL，防 SSRF。
- 只允许 `transport: streamable-http`、`version: 1`、`kind: family-medical-connection`；按 MCP JSON-RPC 发送 `Authorization` 请求头。
- 不信任连接包自报的 `grantId`、scope、过期时间或账号；绑定前必须读取 `get_connection` 并保存服务端返回值。
- 将 Octop 平台提供的可信用户／租户身份作为绑定键，不能接受模型传入的 `userId`、`ownerId`、手机号或通道 ID 来替代平台身份。
- 每个用户独立保存 token。插件重启后从受保护配置恢复；不得用全局 token 代替用户 token。若 Octop 当前插件环境无法获得可信用户／租户上下文或无法隔离存储，先返回无法安全绑定，不能只用模型传来的身份字符串继续。

示意接口（名称不是 Octop SDK 的承诺）：

```ts
bindConnection({ octopUserId, packageText }): Promise<{
  accountId: string; grantId: string; scopes: string[]; expiresAt: string;
}>;
getBoundConnection({ octopUserId }): { url: string; token: string };
```

这些是插件内部接口，`octopUserId` 由平台可信上下文注入，不能作为模型可填写的工具参数；token 也只交给插件内部 MCP 客户端，不作为工具结果回传给模型。连接包中的秘密应在接入时脱敏，不能依赖“密码字段”名称就认为共享专家配置不会泄露。

## 调用约定

先调用 `get_connection` 和 `get_intake_schema`。家庭连接的工具集为 30 个，旧单患者连接仍只发现原有 9 个工具。当前家庭 scope：

`profiles:read`, `profiles:write`, `profiles:delete`, `records:read`, `drafts:write`, `records:manage`, `attachments:read`, `attachments:write`, `attachments:delete`, `shares:manage`, `exports:read`, `audit:read`, `invites:write`, `validation:consent`。

| Scope | 能力边界 |
|---|---|
| `profiles:read` | 档案列表、单个档案、档案Schema与修订历史 |
| `profiles:write` | 建立、修改本人或孩子档案 |
| `profiles:delete` | 明确确认后逻辑移除档案；历史不物理擦除 |
| `records:read` | 读取病程、趋势、摘要、附件目录与记录历史 |
| `drafts:write` | 校验并创建待核对草稿；旧单患者连接适用 |
| `records:manage` | 修改、确认或删除记录；确认／删除须逐项和明确核对 |
| `attachments:read` | 下载授权患者的私有原件 |
| `attachments:write` | 上传PDF、PNG、JPEG原件 |
| `attachments:delete` | 删除未被历史引用的原件 |
| `shares:manage` | 创建、查看、撤销限时摘要分享 |
| `exports:read` | 导出所选患者档案、记录、修订和附件目录 |
| `audit:read` | 查看当前账号的操作审计 |
| `invites:write` | 管理员生成一次性家长邀请码 |
| `validation:consent` | 按用户单独指示调整内部规则验证同意；不提供评分工具 |

普通家庭授权默认不包含管理员邀请码和内部验证同意。服务端最终拒绝任何超出 `get_connection.scopes` 的调用。

账号级工具包括档案建立／修改／删除、档案历史、记录历史、记录修改／确认／删除、检验趋势、附件读取／删除、分享、导出、审计和邀请码。`invites:write` 与 `validation:consent` 默认不授予普通家长。实际可调用范围永远以 `get_connection` 的 `scopes` 为准。

所有写入都遵守以下规则：

- 创建或修订先保存 `draft`；保留原值、单位、日期、时区、来源、附件 ID 和病历式段落，缺项先追问。
- 修改档案或记录前读取当前版本并传 `expectedVersion`；409 时重新读取并让用户核对，不能覆盖。
- 能幂等的操作使用稳定 `messageId`，网络重试保持相同消息 ID 和 payload；收到幂等冲突不可换患者重投。
- `userConfirmed: true` 和 `attestation: true` 只是服务端字段。插件必须从可信 Octop 会话取得用户明确确认，删除、分享、导出、记录确认等高影响操作不得由模型猜测、附件内容或沉默代替。病程本无法独立证明用户是否实际在对话中确认，插件要实现这道检查。
- 只有工具返回成功才向用户报告已保存／已确认。撤销、过期、权限不足、绑定失败或服务不可用时明确失败，不降级为共享凭据或会话记忆。

网页撤销会立即使 token 失效；重发新连接包时按新的服务端 `grantId` 重新绑定。连接包不要自动发送到群聊、飞书或企业微信公共会话。通道身份映射和消息发送由 Octop 插件负责，病程本只记录 `channel` 作为来源追溯，不把它当作鉴权。

## 绑定验收

插件通过 MCP 客户端完成 initialize／工具发现，再调用 `get_connection`。成功结果同时含 `content` 和 `structuredContent`；`isError: true`、`error` 或 `valid: false` 不能当作成功。最少用两名合成用户验收：A绑定后不可被B读取；重复同一写入不新增记录；网页修改后旧版本返回冲突；网页撤销后已初始化客户端也失败；插件重启仍能恢复每个用户自己的绑定。只记录不含秘密的账号／授权标识、错误码和测试结果。

当前交付已用官方 SDK 验收病程本 HTTP／stdio 和家庭隔离，但尚未把凭据发送给用户的真实 Octop 实例；这一步由插件实际接入后验证。

## 不做的事

插件不动态安装 MCP，不创建或扩大 grant，不代用户登录，不修改医学规则，不做诊断、临床评分或风险结论，也不把病程资料写入公共知识库。Octop 的模型、OCR、对话界面、飞书／企业微信通道和自进化发布由插件及智能体侧负责。
