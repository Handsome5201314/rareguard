import type { AgentGrant } from "./types.js";

/** Built only in browser memory after the authenticated user creates a grant. */
export function connectionPackage(endpoint: string, grant: AgentGrant & { token: string }): string {
  const config = { kind: "family-medical-connection", version: 1, transport: "streamable-http", url: endpoint, headers: { Authorization: `Bearer ${grant.token}` }, grantId: grant.id, access: grant.access, scopes: grant.scopes, expiresAt: grant.expiresAt };
  return [
    "请使用已安装的病程本插件，用下面的专属凭据绑定我的病程本账号，随后按我的对话指令维护资料。",
    "", "【连接参数】", JSON.stringify(config, null, 2),
    `授权范围：${grant.access === "family" ? "我的账号下的本人和孩子档案，包含今后新建的档案" : "仅指定患者档案 " + grant.childId}`,
    `允许权限：${grant.scopes.join(", ")}`, `有效期至：${grant.expiresAt}`, `授权编号（撤销用）：${grant.id}`,
    "", "【连接与核对】",
    "1. 调用已安装的病程本插件的绑定功能，由插件保存本次凭据到我的专属配置。插件通过上面的Streamable HTTP地址和Authorization请求头访问病程本；不需要我再输入登录密码。",
    "2. 先实际调用get_connection和get_intake_schema。若是家庭授权，再调用list_profiles；没有档案时询问代称、本人/孩子关系，再调用get_profile_schema和create_profile。",
    "3. 已有档案每次都先与我确认当前患者，调用时传patientId。名字相同或指代不清就追问，不共享其他人的凭据或当前患者状态。网页和对话共用同一份资料。",
    "4. 只有实际工具返回成功后才能报告保存成功；无法联网、无法配置请求头或工具不可用时请如实说明，不能把会话记忆当作已入库。",
    "", "【维护规则】",
    "- 本人/孩子档案、记录、附件、趋势、病历摘要、导出、分享与审计按实际授予权限操作；缺少权限时请我在病程本重新授权，不能绕过。",
    "- 创建或修订病程记录始终先保存待核对草稿。缺少原日期、时区、原值、单位和资料来源时追问，不推断诊断或补零；病历段落引用原记录。",
    "- 修改前读取当前资料，只改我指明的内容；使用当前expectedVersion，冲突后重新读取并和我核对，不能自动覆盖。每个写操作使用稳定唯一messageId，重试保持内容和ID不变。",
    "- 确认记录前完整展示当前版本并让我逐项核对；仅在我明确确认后使用confirm_record并传attestation/userConfirmed。工具会留下智能体代用户操作的来源。",
    "- 删除前讲清对象与后果，分享前讲清范围和有效期并询问明确确认；分享链接和导出只交给我，不自动发送到群聊或第三方。",
    "- 内部规则验证授权必须单独询问，不以一般录入指令代替；不做诊断、临床评分或自行修改医学规则。",
    "", "【凭据与能力边界】",
    "此凭据等同于上述范围的访问权，只存入该账号/会话专属的受保护连接配置；不要复述、写入公开Skill、共享连接器、日志或代码。无需我的账号密码。",
    "插件须预先安装。若当前没有病程本插件、没有绑定功能或工具调用失败，请如实说明；不要尝试动态安装MCP，不把会话记忆当作数据库，也不要报告已绑定或已保存。",
  ].join("\n");
}
