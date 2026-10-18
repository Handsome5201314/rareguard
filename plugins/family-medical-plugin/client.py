"""A fixed-origin MCP client. Never follow redirects with family credentials."""
from __future__ import annotations

import json
import re
from datetime import timedelta
from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

ENDPOINT = "https://bingcheng.tongyimoheai.top/mcp/family"
TOKEN_PATTERN = re.compile(r"family_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])")
MAX_BYTES = 12 * 1024 * 1024


class PluginError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def redact(text: str) -> str:
    return TOKEN_PATTERN.sub("[凭据已隐藏]", text)


def _http_client(headers=None, timeout=None, auth=None):
    return httpx.AsyncClient(headers=headers, timeout=timeout, auth=auth,
                             follow_redirects=False, trust_env=False)


class FamilyClient:
    def __init__(self, endpoint: str = ENDPOINT):
        # The constructor is an internal seam for an isolated HTTP integration test.
        # Model parameters and copied packages never select a different endpoint.
        self.endpoint = endpoint

    async def _request(self, token: str, tool: str | None, arguments: dict[str, Any] | None):
        if not TOKEN_PATTERN.fullmatch(token):
            raise PluginError("INVALID_CREDENTIAL", "病程本凭据格式无效，请重新生成连接包。")
        encoded = json.dumps(arguments or {}, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_BYTES - 4096:
            raise PluginError("INPUT_TOO_LARGE", "工具参数超过病程本请求上限，请分批处理原件。")
        try:
            async with streamablehttp_client(
                self.endpoint, headers={"Authorization": "Bearer " + token},
                timeout=30, sse_read_timeout=60, terminate_on_close=False,
                httpx_client_factory=_http_client,
            ) as (read, write, _):
                async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=60)) as session:
                    await session.initialize()
                    if tool is None:
                        result = await session.list_tools()
                        return {"tools": [item.model_dump(mode="json", by_alias=True, exclude_none=True)
                                          for item in result.tools]}
                    result = await session.call_tool(tool, arguments or {})
                    data = result.structuredContent
                    if data is None:
                        texts = [item.text for item in result.content if item.type == "text"]
                        data = json.loads("".join(texts))
                    if not isinstance(data, dict):
                        raise PluginError("INVALID_RESPONSE", "病程本没有返回结构化结果。")
                    if result.isError or "error" in data:
                        error = data.get("error") or {}
                        code = str(error.get("code", "REMOTE_ERROR"))
                        if not re.fullmatch(r"[A-Z_0-9]{1,80}", code):
                            code = "REMOTE_ERROR"
                        raise PluginError(code, redact(str(error.get("message", "病程工具执行失败。"))))
                    if data.get("valid") is False:
                        raise PluginError("INVALID_INPUT", "字段校验未通过：" + redact(json.dumps(data.get("issues", []), ensure_ascii=False)))
                    serialized = json.dumps(data, ensure_ascii=False, allow_nan=False)
                    if len(serialized.encode("utf-8")) > MAX_BYTES * 2:
                        raise PluginError("OUTPUT_TOO_LARGE", "结果过大，未截断成成功结果；请缩小查询范围。")
                    return data
        except PluginError:
            raise
        except Exception as exc:
            # SDK task groups may wrap HTTP errors. Do not serialize exception bodies,
            # request headers or transport diagnostics into a tool or a chat transcript.
            leaves = [exc]
            while leaves:
                current = leaves.pop()
                if isinstance(current, PluginError):
                    # anyio may group the controlled error raised inside the SDK contexts.
                    raise current from None
                if isinstance(current, httpx.HTTPStatusError):
                    status = current.response.status_code
                    if status == 401:
                        raise PluginError("AGENT_UNAUTHORIZED", "凭据无效、已撤销或已到期。请在病程本生成新连接包。") from None
                    raise PluginError("HTTP_ERROR", f"病程本HTTP {status}；未执行为成功，请检查服务。") from None
                leaves.extend(getattr(current, "exceptions", []))
            raise PluginError("CONNECTION_FAILED", "病程本连接或协议处理失败，请检查服务与网络后重试。") from None

    async def call(self, token: str, tool: str, arguments: dict[str, Any] | None = None):
        return await self._request(token, tool, arguments)

    async def tools(self, token: str):
        return await self._request(token, None, None)
