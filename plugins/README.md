# Octop 插件

| 插件 | 用途 | Octop 工具数 |
| --- | --- | --- |
| [family-medical-plugin](family-medical-plugin/README.md) | 家庭病程绑定、按授权维护档案和记录，敏感写操作预览后明确确认 | 6 |
| [dravet-monitor-plugin](dravet-monitor-plugin/README.md) | 单患者夜间数据只读查询，不控制戒指或触发报警 | 5 |

两个插件独立绑定、独立加密存储；不自动继承彼此授权。服务地址固定为项目 HTTPS MCP 入口。连接包不属于源码，不应粘贴到 Issue、PR、系统提示词或公共会话。私人群聊不能通过聊天昵称建立家庭隔离。

## 安装包与测试

在已经配置好 Octop Python 宿主依赖的隔离开发环境运行下列命令。宿主需能导入 `octop`、`octop_harness`、`langgraph`、`langchain_core`，各插件自己的依赖在 `requirements.txt`。不要为运行测试改写生产插件配置。

```sh
npm --prefix server ci
npm --prefix server run build
python -m unittest discover -s plugins/tests -p 'test_*_plugin.py' -v
python plugins/tests/package_family_plugin.py
python plugins/tests/package_dravet_plugin.py
```

两项打包命令只收录每个插件的六个发布文件，生成 `plugins/dist/*.zip` 及 SHA-256；通过临时 Octop 安装器验收，不安装到生产实例。安装时在 Octop 插件管理上传 ZIP，为目标智能体启用并开始新会话。详细绑定和权限说明见各插件 README。

测试使用真实 Octop loader、LangGraph ToolNode、MCP SDK 和临时 Node / SQLite 实例，账号与采样均为合成数据；不连接生产病程库。测试夹具通过父子进程私有管道传递临时授权，不打印到日志。运行前确保 `node` 为版本 24。

本次本地宿主回归不代表任意 Octop 版本兼容，也不替代真实 IM 通道、真机戒指、整夜采集或临床规则验证。
