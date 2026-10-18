# Octop 接入归档

本目录归档监测插件与智能体初始模板。Octop 是独立宿主；本仓库不包含其宿主源码、实际账号、模型配置、通道配置或用户绑定数据库。

## 安装监测插件

1. 在管理员维护的 Octop 插件管理中安装 [dravet-monitor-plugin-0.1.0.zip](dravet-monitor-plugin-0.1.0.zip)。安装包由仓库 `plugins/dravet-monitor-plugin/` 的唯一维护源码构建。
2. 为指定夜间监测智能体启用插件，开启新会话。不要把宿主中其他专家的权限一并打开。
3. 家长在病程本 `/dravet` 选择自己的患者，单独生成 `dravet-monitor-connection` 只读包，在自己的可信私聊绑定。
4. 先调用 `dravet_status` 和 `dravet_tools`，再按真实 Schema 查询明确时间窗。手机 `dravet-device-pairing` 包交给 App，不能交给插件。

固定 HTTPS 地址与身份校验规则见 [插件说明](../plugins/dravet-monitor-plugin/README.md)，服务端契约见 [Dravet 集成说明](../server/docs/DRAVET-INTEGRATION.md)。若要支持其他部署域名，需要维护端同步审查插件与 App 的地址限制；不能让模型临时指定任意服务器。

## 智能体初始配置

[agent-template/](agent-template/) 的五个文件经过核对，`USER.md` 保留待配置状态，`MEMORY.md` 仅含公共项目事实与契约。复制到为新专家准备的私有工作区后，由管理员配置专家与权限。当前阶段、患者授权和实际同步状态必须重新核对，不因复制模板就标记为完成。

这些文件不应覆盖已经在使用的个人 `USER.md` / `MEMORY.md`。它们也不会自动创建账号、导入患者、开启报警或绑定设备。

## 构建与验证

```sh
python plugins/tests/package_dravet_plugin.py
```

安装包仅包含 `main.py`、`client.py`、`storage.py`、`plugin.yaml`、`requirements.txt`、`README.md`，不包含缓存或私有状态。打包脚本写入 `plugins/dist/` 并通过真实 Octop 安装器验证 ZIP；更新公开归档时，再将核对后的安装包复制到本目录并更新 `docs/archive-assets.json`。这里的公开安装包与当前源码逐文件一致。

集成测试使用真实 Octop loader、ToolNode、MCP SDK 和临时 Node 服务，不使用生产绑定：

```sh
npm --prefix server ci
npm --prefix server run build
<octop-python> -m unittest discover -s plugins/tests -p 'test_*_plugin.py' -v
```

`<octop-python>` 指已能导入 `octop_harness`、`langchain_core`、`langgraph` 与插件依赖的宿主 Python。不要把宿主登录配置复制进仓库。普通 CI 验证源码语法与归档完整性；七项宿主集成测试的本地结果见 [归档记录](../docs/archive-2026-10-19.md)。
