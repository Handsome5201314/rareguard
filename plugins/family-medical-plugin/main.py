"""Octop tools: trusted user binding and explicit, once-only family maintenance."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import threading
from typing import Annotated, Any

from jsonschema import Draft7Validator
from langchain_core.messages import HumanMessage
from langgraph.config import get_config
from langgraph.prebuilt import InjectedState
from octop_harness.plugins import PluginContext

from .client import ENDPOINT, MAX_BYTES, TOKEN_PATTERN, FamilyClient, PluginError, redact
from .storage import BindingStore, owner_key, storage_root

SCOPES = {
    "get_connection": None, "get_intake_schema": None,
    "validate_record_draft": "drafts:write", "list_records": "records:read",
    "create_record_draft": "drafts:write", "update_record_draft": "drafts:write",
    "list_attachments": "records:read", "upload_attachment": "attachments:write",
    "get_medical_summary": "records:read", "list_profiles": "profiles:read",
    "get_profile": "profiles:read", "get_profile_schema": "profiles:read",
    "get_profile_history": "profiles:read", "create_profile": "profiles:write",
    "update_profile": "profiles:write", "delete_profile": "profiles:delete",
    "set_validation_consent": "validation:consent", "get_record_history": "records:read",
    "update_record": "records:manage", "confirm_record": "records:manage",
    "delete_record": "records:manage", "get_lab_trends": "records:read",
    "download_attachment": "attachments:read", "delete_attachment": "attachments:delete",
    "list_shares": "shares:manage", "create_share": "shares:manage",
    "revoke_share": "shares:manage", "export_patient": "exports:read",
    "get_audit": "audit:read", "create_invite": "invites:write",
}
DIRECT_READS = frozenset({
    "get_connection", "get_intake_schema", "validate_record_draft", "list_records",
    "list_attachments", "get_medical_summary", "list_profiles", "get_profile",
    "get_profile_schema", "get_profile_history", "get_record_history",
    "get_lab_trends", "list_shares", "get_audit",
})
_client = FamilyClient()
_store: BindingStore | None = None
_store_lock = threading.Lock()
State = Annotated[dict[str, Any], InjectedState]


def _storage() -> BindingStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = BindingStore(storage_root())
        return _store


def _identity() -> tuple[str, str]:
    try:
        config = get_config().get("configurable") or {}
    except RuntimeError:
        raise PluginError("TRUSTED_USER_REQUIRED", "没有Octop可信用户上下文，不能绑定或读取家庭资料。") from None
    user = config.get("user")
    if isinstance(user, bool) or not re.fullmatch(r"[1-9][0-9]{0,18}", str(user)):
        raise PluginError("TRUSTED_USER_REQUIRED", "没有Octop可信用户身份；通道须先完成平台用户映射。")
    thread = config.get("thread_id")
    if not isinstance(thread, str) or not thread.strip() or len(thread) > 256:
        raise PluginError("TRUSTED_THREAD_REQUIRED", "缺少可信会话标识，请从Octop会话调用插件。")
    source = config.get("source")
    if source in ("dashboard/octop-dashboard", "cli/octop-cli"):
        return owner_key(int(user)), thread
    # In Octop 1.0.2b8, IM configurable.user is the AGENT OWNER, not the sender.
    # Only a canonical, gateway-injected direct session can separate IM parents.
    if not isinstance(source, str) or "/" not in source:
        raise PluginError("TRUSTED_SOURCE_REQUIRED", "缺少可信Octop通道来源，不能判断用户隔离边界。")
    channel, channel_id = source.split("/", 1)
    if channel not in ("feishu", "wecom") or not channel_id or len(channel_id) > 256:
        raise PluginError("CHANNEL_NOT_SUPPORTED", "本插件仅支持Octop网页、CLI、飞书和企业微信可信私聊。")
    session = config.get("session_key")
    agent = config.get("agent_id")
    parts = session.split(":") if isinstance(session, str) and len(session) <= 1024 else []
    if len(parts) != 4 or not isinstance(agent, str) or not agent or parts[0] != agent or parts[1] != channel or not parts[2]:
        raise PluginError("TRUSTED_IM_REQUIRED", "通道未提供可核对的Octop可信私聊身份，请在网页会话使用病程本。")
    if parts[3] != "dm":
        raise PluginError("PRIVATE_CHAT_REQUIRED", "病程资料绑定和维护只接受私聊，群聊、团队转交和共享会话不能调用。")
    principal = json.dumps(["octop-im", int(user), agent, source, parts[2]], ensure_ascii=False)
    return hashlib.sha256(principal.encode()).hexdigest(), thread


def _human(state: dict[str, Any]) -> tuple[str, str]:
    for message in reversed(state.get("messages", [])):
        if isinstance(message, HumanMessage):
            if isinstance(message.content, str):
                text = message.content
            else:
                text = "\n".join(block["text"] for block in message.content
                                 if isinstance(block, dict) and block.get("type") == "text"
                                 and isinstance(block.get("text"), str))
            if not text.strip():
                raise PluginError("USER_MESSAGE_REQUIRED", "缺少家长本次文字指令。")
            key = hashlib.sha256(json.dumps([message.id, text], ensure_ascii=False).encode()).hexdigest()
            return text, key
    raise PluginError("USER_MESSAGE_REQUIRED", "缺少可信用户原消息，不能用模型提供的文字代替。")


def _dump(value) -> str:
    return redact(json.dumps(value, ensure_ascii=False, allow_nan=False))


def _error(exc: PluginError) -> str:
    return _dump({"error": {"code": exc.code, "message": str(exc)}})


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate key")
        value[key] = item
    return value


def _parse_package(text: str) -> str:
    if len(text.encode("utf-8")) > 100000:
        raise PluginError("INVALID_PACKAGE", "连接消息过长，请只发送网页生成的专属连接包。")
    decoder = json.JSONDecoder(object_pairs_hook=_unique_object)
    candidates = []
    for found in re.finditer(r"\{", text):
        try:
            obj, _ = decoder.raw_decode(text, found.start())
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get("kind") == "family-medical-connection":
            candidates.append(obj)
    if len(candidates) != 1:
        raise PluginError("INVALID_PACKAGE", "请发送唯一一份病程本网页生成的完整连接包。")
    obj = candidates[0]
    if type(obj.get("version")) is not int or obj["version"] != 1 or obj.get("transport") != "streamable-http":
        raise PluginError("INVALID_PACKAGE", "连接包版本或传输方式不支持。")
    if obj.get("url") != ENDPOINT:
        raise PluginError("ENDPOINT_NOT_ALLOWED", "连接地址不是本插件固定的病程本公网地址，拒绝发送凭据。")
    headers = obj.get("headers")
    if not isinstance(headers, dict) or set(headers) != {"Authorization"}:
        raise PluginError("INVALID_CREDENTIAL", "连接包只能含病程本Authorization请求头。")
    authorization = headers.get("Authorization")
    if not isinstance(authorization, str) or not authorization.startswith("Bearer "):
        raise PluginError("INVALID_CREDENTIAL", "连接包缺少有效凭据。")
    token = authorization[7:]
    if not TOKEN_PATTERN.fullmatch(token):
        raise PluginError("INVALID_CREDENTIAL", "凭据格式无效，请从网页重新生成。")
    return token


async def _live(owner: str):
    binding = _storage().get(owner)
    connection = await _client.call(binding["token"], "get_connection")
    previous = binding["connection"]
    if connection.get("grantId") != previous.get("grantId") or connection.get("account", {}).get("id") != previous.get("account", {}).get("id"):
        raise PluginError("BINDING_CHANGED", "病程本授权身份发生变化，请重新绑定。")
    return binding, connection


async def bingcheng_bind(state: State) -> str:
    """从当前家长原消息解析连接包，验证后绑定可信Octop用户。"""
    try:
        owner, _ = _identity()
        raw, _ = _human(state)
        token = _parse_package(raw)
        info = await _client.call(token, "get_connection")
        if not info.get("account", {}).get("id") or not info.get("grantId") or info.get("access") not in ("family", "patient"):
            raise PluginError("INVALID_RESPONSE", "病程本未返回完整授权身份，未保存绑定。")
        _storage().bind(owner, {"token": token, "connection": info})
        return _dump({"bound": True, "connection": info,
                      "nextAction": "先get_intake_schema；家庭连接再list_profiles，与家长核对本人或孩子。不要复述连接包。"})
    except PluginError as exc:
        return _error(exc)


async def bingcheng_status() -> str:
    """实时核对当前用户病程本连接，撤销或过期立即失败。"""
    try:
        owner, _ = _identity()
        _, info = await _live(owner)
        return _dump({"bound": True, "connection": info})
    except PluginError as exc:
        return _error(exc)


async def bingcheng_tools() -> str:
    """从病程本实际发现工具和字段规范，再按Schema调用。"""
    try:
        owner, _ = _identity()
        binding, info = await _live(owner)
        catalog = await _client.tools(binding["token"])
        return _dump({"tools": [item for item in catalog["tools"] if item["name"] in SCOPES],
                      "scopes": info["scopes"], "notice": "工具发现不等于权限授予。只读可直接请求；写入、导出和下载原件需先预览并取得新消息确认。"})
    except PluginError as exc:
        return _error(exc)


async def bingcheng_request(tool_name: str, arguments: dict[str, Any], state: State) -> str:
    """查询资料或生成维护预览，不能直接跳过家长确认写入。"""
    try:
        owner, thread = _identity()
        raw, human_key = _human(state)
        if tool_name not in SCOPES:
            raise PluginError("TOOL_NOT_ALLOWED", "不是病程本允许的工具；不提供诊断、评分或修改规则。")
        try:
            canonical = json.dumps(arguments, ensure_ascii=False, sort_keys=True, allow_nan=False)
        except (ValueError, TypeError):
            raise PluginError("INVALID_INPUT", "arguments必须是标准JSON对象。") from None
        if len(canonical.encode()) > MAX_BYTES - 4096:
            raise PluginError("INPUT_TOO_LARGE", "参数过大，请分批上传或查询。")
        if TOKEN_PATTERN.search(raw) or TOKEN_PATTERN.search(canonical):
            raise PluginError("CREDENTIAL_IN_INPUT", "请先完成绑定，再用新消息描述操作；不能把连接凭据当病程内容。")
        binding, info = await _live(owner)
        required_scope = SCOPES[tool_name]
        if required_scope and required_scope not in info["scopes"]:
            raise PluginError("AGENT_SCOPE", "本连接没有所需权限：" + required_scope + "；请在网页重新授权。")
        catalog = await _client.tools(binding["token"])
        descriptor = next((item for item in catalog["tools"] if item["name"] == tool_name), None)
        if descriptor is None:
            raise PluginError("TOOL_UNAVAILABLE", "本连接没有此工具；单患者凭据不能维护家庭档案。")
        schema = descriptor["inputSchema"]
        properties = schema.get("properties", {})
        controlled = {"messageId", "channel", "sourceText", "userConfirmed", "attestation"}
        args = {key: value for key, value in arguments.items() if key not in controlled}
        if info["access"] == "family" and "patientId" in properties and not args.get("patientId"):
            raise PluginError("PATIENT_REQUIRED", "请先list_profiles，与家长核对本人或哪个孩子，再明确传patientId。")
        operation_id = "bc-" + hashlib.sha256(json.dumps([owner, thread, info["grantId"], human_key, tool_name, args], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if "messageId" in properties:
            source = get_config()["configurable"]["source"].split("/", 1)[0]
            args.update(messageId=operation_id, channel=source if source in ("feishu", "wecom") else "octop", sourceText=raw[:10000])
        for field in ("userConfirmed", "attestation"):
            if field in properties:
                args[field] = True  # Staged only; never transmitted until claim of a NEW user confirmation.
        errors = list(Draft7Validator(schema).iter_errors(args))
        if errors:
            fields = [".".join(map(str, item.absolute_path)) or "arguments" for item in errors[:10]]
            raise PluginError("INVALID_INPUT", "参数不符合已发现的Schema，请核对字段：" + ", ".join(fields))
        if tool_name in DIRECT_READS:
            return _dump(await _client.call(binding["token"], tool_name, args))
        preview_args = {key: value for key, value in args.items() if key not in controlled}
        current = {}
        patient_id = args.get("patientId")
        if patient_id:
            if info["access"] == "family":
                current.update(await _client.call(binding["token"], "get_profile", {"patientId": patient_id}))
            else:
                current["profile"] = info["child"]
        elif info["access"] == "patient":
            current["profile"] = info["child"]
        if tool_name in ("update_record", "update_record_draft", "confirm_record", "delete_record"):
            records = await _client.call(binding["token"], "list_records", {"patientId": patient_id} if patient_id else {})
            record = next((item for item in records["records"] if item["id"] == args["recordId"]), None)
            if not record:
                raise PluginError("RECORD_NOT_FOUND", "所选患者中找不到此记录。")
            current["record"] = record
            if record["version"] != args["expectedVersion"]:
                raise PluginError("VERSION_CONFLICT", "记录已经更新，请重新读取、核对并生成预览。")
        if tool_name in ("update_profile", "delete_profile", "set_validation_consent") and current["profile"]["version"] != args["expectedVersion"]:
            raise PluginError("VERSION_CONFLICT", "档案已经更新，请重新读取、核对并生成预览。")
        if tool_name in ("create_record_draft", "update_record_draft", "update_record"):
            await _client.call(binding["token"], "validate_record_draft", {"record": args["record"]})
        if tool_name == "upload_attachment":
            try:
                data = base64.b64decode(args["base64"], validate=True)
            except ValueError:
                raise PluginError("INVALID_BASE64", "原件不是标准base64编码。") from None
            preview_args.pop("base64")
            preview_args.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        notices = {
            "confirm_record": "请逐项核对完整当前版本的日期、时间、单位、来源、附件和病历段落；确认后转为已确认。",
            "delete_profile": "移除档案并撤销分享；加密历史仍保留，不能解释为物理擦除。",
            "delete_record": "逻辑移除记录，历史仍保留。",
            "create_share": "任何持有分享链接的人都能读取代称、诊断与已确认摘要；不含原件。插件不代发给他人。",
            "export_patient": "导出所选患者档案、版本、记录和附件目录；内容会返回当前智能体会话。",
            "download_attachment": "原件内容会返回当前智能体会话，请确认当前会话可接收敏感资料。",
            "set_validation_consent": "这是单独变更内部验证同意；普通录入维护不构成此项授权。",
        }
        value = {"code": "BC-" + secrets.token_hex(5).upper(), "humanKey": human_key,
                 "grantId": info["grantId"], "request": {"tool": tool_name, "arguments": args},
                 "preview": {"tool": tool_name, "current": current, "arguments": preview_args,
                             "notice": notices.get(tool_name, "请核对对象和全部待执行内容；新增或修订病程仍为待核对草稿。")}}
        pending = _storage().prepare(owner, thread, operation_id, value)
        if "result" in pending:
            return _dump({"replayed": True, "result": pending["result"]})
        return _dump({"status": "awaiting_confirmation", "preview": pending["preview"],
                      "confirmation": "确认执行 " + pending["code"], "expiresInMinutes": 15,
                      "instruction": "向家长完整展示预览，请家长用新消息原样回复确认指令，再调用bingcheng_confirm。此时尚未执行。"})
    except PluginError as exc:
        return _error(exc)


async def bingcheng_confirm(state: State) -> str:
    """只接受家长后续原消息中的精确确认指令，原子执行一次。"""
    try:
        owner, thread = _identity()
        raw, key = _human(state)
        match = re.fullmatch(r"确认执行\s+(BC-[A-F0-9]{10})", raw.strip())
        if not match:
            raise PluginError("CONFIRMATION_REQUIRED", "请家长看到完整预览后，以新消息原样回复“确认执行 BC-确认码”。")
        binding, info = await _live(owner)
        request_id, pending, cached = _storage().claim(owner, thread, match[1], key, info["grantId"])
        if cached:
            return _dump({"replayed": True, "result": pending["result"]})
        request = pending["request"]
        try:
            result = await _client.call(binding["token"], request["tool"], request["arguments"])
            outcome = {"executed": True, "tool": request["tool"], "data": result}
        except PluginError as exc:
            outcome = {"error": {"code": exc.code, "message": str(exc)},
                       "nextAction": "未确认执行成功。网络失败时结果可能已写入，先在网页核对；插件不会自动重发。版本冲突须重新读取和确认。"}
        pending["result"] = outcome
        _storage().finish(owner, request_id, pending)
        return _dump(outcome)
    except PluginError as exc:
        return _error(exc)


async def bingcheng_unbind(state: State) -> str:
    """按家长明确原消息解除本地绑定；网页撤销才使凭据真正作废。"""
    try:
        owner, _ = _identity()
        raw, _ = _human(state)
        if raw.strip() not in ("解除病程本绑定", "解绑病程本"):
            raise PluginError("CONFIRMATION_REQUIRED", "请家长以新消息明确说“解除病程本绑定”。")
        _storage().unbind(owner)
        return _dump({"unbound": True, "notice": "已清除当前Octop用户本地绑定和待确认操作。请在病程本“智能体连接”撤销旧授权，才会使旧凭据作废。"})
    except PluginError as exc:
        return _error(exc)


def setup(ctx: PluginContext) -> None:
    for name, function, description in (
        ("bingcheng_bind", bingcheng_bind, "解析家长当前原消息里的病程本完整连接包并验证绑定。无凭据参数，不索账号密码；不要复述或记忆凭据。"),
        ("bingcheng_status", bingcheng_status, "实时检查当前Octop用户的病程本授权，撤销或过期明确失败。"),
        ("bingcheng_tools", bingcheng_tools, "读取实际病程本工具目录及JSON Schema。先发现规范，按已授予scope操作。"),
        ("bingcheng_request", bingcheng_request, "tool_name为病程本工具名，arguments为Schema对应JSON对象。查询直接执行；写入、确认、删除、分享、导出、原件下载先返回完整预览。必须向家长展示预览，等待新消息精确确认码；模型提供userConfirmed无效。先核对本人或孩子并明确patientId，保留版本、原单位和来源；失败不得声称成功。"),
        ("bingcheng_confirm", bingcheng_confirm, "家长看到完整预览后，以新消息回复精确“确认执行 BC-确认码”时调用；读取平台注入原消息，执行当前用户当前会话的待确认操作一次，不接受模型传入确认码或用户身份。"),
        ("bingcheng_unbind", bingcheng_unbind, "仅在家长原消息明确“解除病程本绑定”时清除其本地绑定。提醒在网页撤销旧授权；不影响其他用户。"),
    ):
        ctx.tool(name, function, description=description)
