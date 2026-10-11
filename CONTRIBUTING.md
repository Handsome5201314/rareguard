# 协作开发

请从 `main` 创建功能分支，通过 Pull Request 说明问题、改动和验证结果。App 与 API 契约变更在同一 PR 中提交，避免队友拉到不能联调的版本。

## 模块边界

- App 界面在 `app/lib/`，沿用 `design.dart` 的颜色与组件；不要把 BLE 解析和实验规则放进 Widget。
- Android 采集、私有 SQLite 与配对安全存储在 `app/android/app/src/main/java/org/rareguard/app/`；纯协议与规则在 `org/rareguard/core/`。
- API 与授权在 `server/server/`，数据结构变更同时维护 `schemas.py`、`models.py`、迁移及合成契约测试。
- Hermes worker 只接收经授权的窗口摘要。不要将 API key、模型凭据或 SSH 信息下发到 App。

## 提交前验证

```sh
python tools/check_public_tree.py
cd app
flutter pub get
flutter analyze
flutter test
bash scripts/check_core.sh
```

Windows 的协议与规则检查使用 `powershell -File scripts/check_core.ps1`。服务端使用专用本地测试库，按 `server/README.md` 配置后运行 `python scripts/local.py test`；测试会清空该测试库，不能使用业务数据库。

首次迁移、API 授权、数据来源、同步或实验规则变更必须有相应验证。设备实测记录保存在本地忽略目录，不提交原始健康数据。没有实际验证的设备、指标或送达能力，请在 PR 中注明。

## 隐私与配置

复制 `server/.env.example` 为本地 `.env`，填写自己的配置。`.env`、`runtime/`、数据库、导出文件、设备截图与签名文件均被忽略。生产运维配置继续保存在项目负责人指定的私有配置文件中，不从公共仓库分发。

提交前检查 `git diff --cached`；误提交敏感数据后，删除工作区文件不会清除 Git 历史，必须先停止推送并通知维护者。Issue 和 PR 仅使用合成、脱敏复现，禁止粘贴配对码、token、密码、家庭标识、蓝牙 MAC 或真实健康记录。
