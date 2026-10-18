# RareGuard · 病程本与家庭夜间观察

把家长维护的病程、戒指采样和受限智能体协作放在同一套源码中。Flutter Android App 连接 MR11，Node.js 服务端保存授权上传与病程，家长网页展示时间线和趋势，Octop 插件按真实授权查询或维护资料。

## 项目目录

| 路径 | 内容 |
| --- | --- |
| [app/](app/README.md) | Flutter 界面、Android BLE / 本地队列与授权上传，版本 0.3.0+3 |
| [server/](server/README.md) | Node.js 24 / TypeScript / SQLite，病程 HTTP / MCP、Dravet 上传与查询 |
| [family-web/](family-web/README.md) | 家长病程网页、档案、核对、时间线、趋势、附件与智能体连接 |
| [plugins/](plugins/README.md) | Octop 家庭病程与 Dravet 两个插件、合成集成测试与 ZIP 构建 |
| [docs/architecture.md](docs/architecture.md) | 数据流与权限边界 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发、验证与提交方式 |

## 启动病程本

需要 Node.js 24；以下命令在仓库根目录运行：

```sh
git clone https://github.com/Handsome5201314/rareguard.git
cd rareguard
npm --prefix server ci
npm --prefix server run build
npm --prefix family-web ci
npm --prefix family-web run build
npm --prefix family-web start
```

打开 http://127.0.0.1:7870，首次在本机建立管理员，然后邀请家长。数据默认保存在 `family-web/family-data/`，被 Git 忽略；已有正式实例时使用不同端口和独立数据目录。单独后端、配置和备份见 [服务端说明](server/README.md)。

App 开发需要 Flutter 3.47.5 / Dart 3.13.4、JDK 17 和 Android SDK，步骤见 [App 说明](app/README.md)。Octop 需单独安装与配置，插件构建见 [plugins](plugins/README.md)。

## 能力与验证边界

病程记录先存草稿，核对和修订保留来源及版本；智能体使用可撤销的家庭或单患者授权。手机上传凭据、家长会话与智能体只读监测授权分别校验。夜间数据保留时间、单位、质量及 measured / replay / synthetic 来源，采样空窗不能解释为安全。

当前没有经临床验证的癫痫识别或动态医学预警。服务端记录观察与提醒事件，不执行医学规则、远程推送或戒指控制。真实 MR11 配对、整夜采集、断网补传、原生 WebView 登录与绑定后的 Octop 对话仍须实机验收。

公共仓库只包含开发源码、合成测试和配置模板；不包含凭据、真实健康资料、设备标识、运行数据库、设备截图、官方 APK 或反编译产物。构建测试包沿用开发签名；正式签名尚未配置。

未选择项目开源许可证。App 图片来源见 `app/assets/images/provenance.json`，网页参考边界见 [OPEN_SOURCE](family-web/OPEN_SOURCE.md)；来源说明不代表对第三方素材的授权。历史整理记录见 [publication](docs/publication.md)。
