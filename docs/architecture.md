# 数据流与契约

## App

`MR11 → RingService → EfeProtocol / MeasurementWindow → LocalStore → NativeController → Flutter`

BLE 采集在 Android 前台服务中执行。`EfeProtocol` 解析即时、历史、测量状态与停止回包；命令应答不算有效采样。`MeasurementWindow` 为单次测量设定有界窗口，禁止冲突测量。官方错误码 1 为设备判定未正确佩戴，2 为未检测到有效心率，错误不能直接解释为硬件损坏。

本地 SQLite 保存来源、单位、质量、手机接收时间和设备本地时间；历史时间未经校准，不替换为手机接收时间。首页只使用即时数据。配对凭据用 Android Keystore 加密，Hermes 凭据仅留在服务端。

## 服务端

`LocalStore 待同步记录 → RemoteApi → FastAPI 授权 / schema 校验 → PostgreSQL → 窗口摘要 → Hermes worker`

API 接收端路径为 `/v1/...`；公网网关对 `/api/` 去除前缀。`/console` 使用独立密码登录、Secure Cookie、来源检查和 CSRF 校验。App 使用独立的一次性配对码交换 Bearer 凭据；每个请求校验所属家庭与操作授权。

| 接口组 | 契约 |
| --- | --- |
| 配对与设备 | 十分钟一次性配对码；设备登记绑定家庭 |
| measurement-batches | `schema_version=1`，最多 500 条；来源、时间、质量与单位显式记录 |
| observations | 发生时间与记录时间分别保存；用户输入作为资料处理 |
| consent / alerts / receipts | 上传、AI、远程提醒分别授权；送达与查看确认分别记录 |
| summaries / conversations | 明确窗口与时区；无数据、质量未知、分页与采样空窗不能解释为安全 |

完整字段以 `server/server/schemas.py` 为准，路由以 `main.py` / `console.py` 为准。本地开发可通过 FastAPI `/docs` 查看接口；公共网关应按部署要求限制文档和 internal 路由。

Hermes 请求需要配置真实服务，`HERMES_MODEL` 必须与返回的 model 一致，默认 profile 为 `dravet-night`。worker 验证授权、租约和超时，未配置或响应不完整时保留可观察失败状态。Agent 需单独配置为受限数据解释环境；设置 `HERMES_RESTRICTED_CONTEXT_CONFIRMED=true` 之前应确认不能运行工具或保存长期记忆。

## 待验证能力

轮询提醒不是系统厂商推送。锁屏持续采集、卓易通 BLE 与后台能力、双监护人跨网送达、连续覆盖和三轴动作算法必须通过独立实机验证。本仓库不包含真实采样或验证截图，合成测试不能替代这些验证。
