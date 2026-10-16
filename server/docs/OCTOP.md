# Octop 接入病程本

病程本是独立的家庭病程资料服务，Octop 负责对话、模型、OCR、消息通道和插件编排。请先阅读 [PLUGIN-CONTRACT.md](PLUGIN-CONTRACT.md)，再按本文联调；本文不假设任何未由用户提供的 Octop SDK 接口。

## 家长操作

登录病程本 → “智能体连接” → 选择“本人和孩子 · 账号维护连接”或已有患者的“草稿录入连接” → 选择有效期和权限 → 勾选同意 → “生成我的连接包” → “复制凭据和说明” → 粘贴给已预装的病程本插件。凭据只显示一次，遗失后撤销并重新生成；无需发送病程本登录密码。账号级连接可在尚未建档时生成，随后通过对话建立本人或孩子档案。

## MCP 地址

公网 endpoint：`https://bingcheng.tongyimoheai.top/mcp/family`。同机 endpoint：`http://127.0.0.1:7870/mcp/family`。请求使用 `Authorization: Bearer <连接包中的专用token>`，POST Streamable HTTP JSON-RPC；GET／DELETE 返回405，请求体上限12 MiB。公网服务和本机电脑、SSH隧道必须同时在线。

插件应固定允许的服务 origin，绑定前实际调用 `get_connection`，不信任连接包自报账号或权限。家庭连接每次先 `list_profiles` 并由用户选定 `patientId`；服务端按 token 校验家庭归属。撤销／到期后调用立即失效。

## 工具与权限

所有连接都有：`get_connection`、`get_intake_schema`、`validate_record_draft`、`list_records`、`create_record_draft`、`update_record_draft`、`list_attachments`、`upload_attachment`、`get_medical_summary`。

家庭连接另外有：`list_profiles`、`get_profile`、`get_profile_schema`、`get_profile_history`、`create_profile`、`update_profile`、`delete_profile`、`set_validation_consent`、`get_record_history`、`update_record`、`confirm_record`、`delete_record`、`get_lab_trends`、`download_attachment`、`delete_attachment`、`list_shares`、`create_share`、`revoke_share`、`export_patient`、`get_audit`、`create_invite`，共30个工具。实际是否可调用由 `scopes` 决定；普通家长默认不含 `invites:write` 和 `validation:consent`。

账号级连接支持维护本人及孩子，旧单患者连接仍只支持一个患者和原9工具，不能静默升级。完整字段、版本、幂等、确认和插件身份要求见 [PLUGIN-CONTRACT.md](PLUGIN-CONTRACT.md)。

## 首次检查

插件绑定后依次调用 `get_connection`、`get_intake_schema`；没有档案时向用户询问代称和关系，再调用 `get_profile_schema`、`create_profile`。对话写入只能产生待核对草稿；家长可在网页刷新、查看和确认，同一资料也可由获得相应 scope 的对话维护。Octop 实例、专家和飞书／企业微信通道的真实联调仍由用户完成，本工程不声称已经连接用户的 Octop。
