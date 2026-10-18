"""Read-only Octop monitoring tools with trusted, per-user bindings."""
from __future__ import annotations

import hashlib
import json
import re
import threading
from typing import Annotated, Any
from jsonschema import Draft7Validator
from langchain_core.messages import HumanMessage
from langgraph.config import get_config
from langgraph.prebuilt import InjectedState
from octop_harness.plugins import PluginContext
from .client import ENDPOINT, MAX_BYTES, TOKEN_PATTERN, DravetClient, PluginError, redact
from .storage import BindingStore, owner_key, storage_root

TOOLS = frozenset({'get_connection', 'list_devices', 'get_samples', 'get_events', 'get_night_summary'})
State = Annotated[dict[str, Any], InjectedState]
_client = DravetClient()
_store = None
_lock = threading.Lock()


def _storage():
    global _store
    with _lock:
        if _store is None:
            _store = BindingStore(storage_root())
        return _store


def _identity():
    try:
        config = get_config().get('configurable') or {}
    except RuntimeError:
        raise PluginError('TRUSTED_USER_REQUIRED', '缺少 Octop 可信用户上下文。') from None
    user, thread, source = config.get('user'), config.get('thread_id'), config.get('source')
    if isinstance(user, bool) or not re.fullmatch(r'[1-9][0-9]{0,18}', str(user)):
        raise PluginError('TRUSTED_USER_REQUIRED', '缺少 Octop 可信用户身份。')
    if not isinstance(thread, str) or not thread.strip() or len(thread) > 256:
        raise PluginError('TRUSTED_THREAD_REQUIRED', '缺少可信会话标识。')
    if source in ('dashboard/octop-dashboard', 'cli/octop-cli'):
        return owner_key(int(user))
    if not isinstance(source, str) or '/' not in source:
        raise PluginError('TRUSTED_SOURCE_REQUIRED', '缺少可信通道来源。')
    channel, channel_id = source.split('/', 1)
    if channel not in ('feishu', 'wecom') or not channel_id or len(channel_id) > 256:
        raise PluginError('CHANNEL_NOT_SUPPORTED', '仅支持网页、CLI、飞书和企业微信可信私聊。')
    session, agent = config.get('session_key'), config.get('agent_id')
    parts = session.split(':') if isinstance(session, str) and len(session) <= 1024 else []
    if len(parts) != 4 or not isinstance(agent, str) or not agent or parts[0] != agent or parts[1] != channel or not parts[2]:
        raise PluginError('TRUSTED_IM_REQUIRED', '通道未提供可信私聊身份。')
    if parts[3] != 'dm':
        raise PluginError('PRIVATE_CHAT_REQUIRED', '监测绑定和查询只接受可信私聊。')
    return hashlib.sha256(json.dumps(['octop-im', int(user), agent, source, parts[2]], ensure_ascii=False).encode()).hexdigest()


def _human(state):
    for message in reversed(state.get('messages', [])):
        if isinstance(message, HumanMessage):
            raw = message.content if isinstance(message.content, str) else '\n'.join(b['text'] for b in message.content if isinstance(b, dict) and b.get('type') == 'text' and isinstance(b.get('text'), str))
            if raw.strip():
                return raw
            break
    raise PluginError('USER_MESSAGE_REQUIRED', '缺少可信用户原消息。')


def _unique(pairs):
    obj = {}
    for k, v in pairs:
        if k in obj:
            raise ValueError('duplicate key')
        obj[k] = v
    return obj


def _parse_package(raw):
    if len(raw.encode()) > 100000:
        raise PluginError('INVALID_PACKAGE', '连接消息过长。')
    candidates, decoder = [], json.JSONDecoder(object_pairs_hook=_unique)
    for found in re.finditer(r'\{', raw):
        try:
            obj, _ = decoder.raw_decode(raw, found.start())
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get('kind') == 'dravet-monitor-connection':
            candidates.append(obj)
    if len(candidates) != 1:
        raise PluginError('INVALID_PACKAGE', '请发送唯一完整的夜间监测只读连接包。')
    obj = candidates[0]
    if set(obj) != {'kind', 'version', 'url', 'token'} or type(obj['version']) is not int or obj['version'] != 1:
        raise PluginError('INVALID_PACKAGE', '连接包字段或版本不支持。')
    if obj['url'] != ENDPOINT:
        raise PluginError('ENDPOINT_NOT_ALLOWED', '连接地址不是插件固定的监测服务，拒绝发送凭据。')
    if not isinstance(obj['token'], str) or not TOKEN_PATTERN.fullmatch(obj['token']):
        raise PluginError('INVALID_CREDENTIAL', '不是监测只读凭据。')
    return obj['token']


def _dump(value):
    return redact(json.dumps(value, ensure_ascii=False, allow_nan=False))


def _error(exc):
    return _dump({'error': {'code': exc.code, 'message': str(exc)}})


async def _live(owner):
    binding = _storage().get(owner)
    info = await _client.call(binding['token'], 'get_connection')
    previous = binding['connection']
    if any(info.get(k) != previous.get(k) for k in ('grantId', 'account', 'patient')):
        raise PluginError('BINDING_CHANGED', '监测授权对象发生变化，请重新绑定。')
    if info.get('scopes') != ['monitoring:read']:
        raise PluginError('AGENT_SCOPE', '连接不是单患者监测只读授权。')
    return binding, info


async def dravet_bind(state: State) -> str:
    """从真实用户原消息绑定单患者监测只读连接，不接受模型提供的凭据。"""
    try:
        owner = _identity()
        token = _parse_package(_human(state))
        info = await _client.call(token, 'get_connection')
        if not info.get('account', {}).get('id') or not info.get('grantId') or not info.get('patient', {}).get('id') or info.get('scopes') != ['monitoring:read']:
            raise PluginError('INVALID_RESPONSE', '服务未返回完整只读授权，未保存绑定。')
        _storage().bind(owner, {'token': token, 'connection': info})
        return _dump({'bound': True, 'connection': info, 'notice': '仅当前患者监测只读；不控制戒指，不修改规则，不发送警报。'})
    except PluginError as e:
        return _error(e)


async def dravet_status() -> str:
    """实时核对当前用户授权与撤销状态。"""
    try:
        _, info = await _live(_identity())
        return _dump({'bound': True, 'connection': info})
    except PluginError as e:
        return _error(e)


async def dravet_tools() -> str:
    """读取真实监测服务工具 Schema。"""
    try:
        binding, info = await _live(_identity())
        catalog = await _client.tools(binding['token'])
        return _dump({'tools': [t for t in catalog['tools'] if t['name'] in TOOLS], 'scopes': info['scopes']})
    except PluginError as e:
        return _error(e)


async def dravet_request(tool_name: str, arguments: dict[str, Any], state: State) -> str:
    """按已发现 Schema 查询单患者监测数据；时间窗必须含明确时区。"""
    try:
        owner, raw = _identity(), _human(state)
        if tool_name not in TOOLS:
            raise PluginError('TOOL_NOT_ALLOWED', '仅允许五个监测只读工具。')
        allowed = set() if tool_name in ('get_connection', 'list_devices') else {'from', 'to', 'limit'}
        if set(arguments) - allowed:
            raise PluginError('INVALID_INPUT', '只接受查询时间窗参数，不接受用户、患者或其他身份字段。')
        encoded = json.dumps(arguments, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode()) > MAX_BYTES - 4096:
            raise PluginError('INPUT_TOO_LARGE', '请缩小查询范围。')
        if redact(raw) != raw or redact(encoded) != encoded:
            raise PluginError('CREDENTIAL_IN_INPUT', '请绑定后以新消息查询，不把凭据当作监测内容。')
        binding, _ = await _live(owner)
        catalog = await _client.tools(binding['token'])
        descriptor = next((t for t in catalog['tools'] if t['name'] == tool_name), None)
        if not descriptor:
            raise PluginError('TOOL_UNAVAILABLE', '服务没有此只读工具。')
        if list(Draft7Validator(descriptor['inputSchema']).iter_errors(arguments)):
            raise PluginError('INVALID_INPUT', '参数不符合服务 Schema；不要提供患者身份或省略时区。')
        return _dump(await _client.call(binding['token'], tool_name, arguments))
    except (ValueError, TypeError) as e:
        return _error(e if isinstance(e, PluginError) else PluginError('INVALID_INPUT', '参数必须是标准 JSON 对象。'))


async def dravet_unbind(state: State) -> str:
    """按家长真实解绑指令清除其本地绑定；服务撤销在网页完成。"""
    try:
        owner = _identity()
        if _human(state).strip() not in ('解除夜间监测绑定', '解绑夜间监测'):
            raise PluginError('CONFIRMATION_REQUIRED', '请明确说“解除夜间监测绑定”。')
        _storage().unbind(owner)
        return _dump({'unbound': True, 'notice': '请到夜间监测网页撤销授权，使原凭据失效。'})
    except PluginError as e:
        return _error(e)


def setup(ctx: PluginContext) -> None:
    for name, fn in (('dravet_bind', dravet_bind), ('dravet_status', dravet_status), ('dravet_tools', dravet_tools), ('dravet_request', dravet_request), ('dravet_unbind', dravet_unbind)):
        ctx.tool(name, fn, description=fn.__doc__)
