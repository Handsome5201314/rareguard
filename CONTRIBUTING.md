# 协作开发

从 `main` 创建功能分支，通过 Pull Request 说明问题、改动和验证。App、网页与 API 契约变更在同一 PR 中提交，避免不能联调的版本。

## 模块边界

- `app/lib/` 维护 Flutter 界面；Android BLE / 私有 SQLite 在 `app/android/app/src/main/java/org/rareguard/app/`，协议与规则在 `org/rareguard/core/`。
- `server/src/server/` 负责病程、权限、SQLite、HTTP 与 MCP；`server/src/dravet/` 负责监测授权与上传；共享契约只维护于 `server/src/shared/`。
- `family-web/web/` 维护家长网页，不复制服务端领域逻辑。Vite 构建不包含运行数据库或配置。
- `plugins/` 维护 Octop 工具与每用户绑定。身份只接受宿主可信上下文，不允许模型指定 owner 或凭据。

## 提交前验证

按改动范围运行，在仓库根目录：

```sh
npm --prefix server ci
npm --prefix server run typecheck
npm --prefix server test
npm --prefix family-web ci
npm --prefix family-web run build
python -m compileall -q plugins
python tools/check_public_tree.py
```

插件还需在已具备 Octop 宿主依赖的开发环境执行 [真实集成测试与打包](plugins/README.md)。修改 App 时按 [App 说明](app/README.md) 运行 Flutter analyze、test 与协议／规则检查。Windows 协议检查用 `powershell -File app/scripts/check_core.ps1`。

首次迁移、授权、数据来源、同步或实验规则变更必须有对应验证。测试只使用临时目录、独立测试库和合成资料。真实设备与临床能力未验证时必须如实说明。

## 隐私与提交

提交前先暂存明确选择的源文件，再运行隐私检查并审查 `git diff --cached`。凭据、连接包、真实病程、蓝牙地址、运行目录、数据库、密钥、截图、签名文件和私人配置不能进入 Git。Issue / PR 仅使用合成或脱敏复现。

公共源码不授予现网账户或数据访问权限。不要使用生产数据启动验证，不自动安装到生产 Octop，也不要修改其他部署的配置。
