# RareGuard

家庭夜间观察项目的 App 与服务端源码。Flutter Android App 通过原生 BLE 前台服务连接 MR11；FastAPI / PostgreSQL 保存经授权上传的采样、观察、提醒回执与明确时间窗的摘要。Hermes 问答默认使用 `dravet-night` profile。

## 目录

| 路径 | 内容 |
| --- | --- |
| [app/](app/) | Flutter 界面、Android BLE / 本地存储、协议与实验规则、测试和图片资产 |
| [server/](server/) | FastAPI、PostgreSQL 模型与迁移、登录控制台、Hermes worker 与测试 |
| [docs/architecture.md](docs/architecture.md) | 数据流、接口边界与功能限制 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 队友开发、验证与提交方式 |
| [docs/publication.md](docs/publication.md) | 此次源码整理、隐私排除和验证记录 |

## 开始开发

```sh
git clone https://github.com/Handsome5201314/rareguard.git
cd rareguard
```

App 使用 Flutter **3.47.5** / Dart **3.13.4**、JDK **17** 和 Android SDK；服务端使用 Python **3.12** 与 PostgreSQL **17**。完整步骤见 [App 开发说明](app/README.md) 和 [服务端开发说明](server/README.md)。

源码保留项目原有公开业务地址，App 设置支持填写自己的 HTTPS API。配对凭据和上传、AI、远程提醒授权分别管理；公共仓库不授予现网账号或家庭数据访问权限。开发请使用自己的测试服务与合成数据。

## 当前能力

“今夜 / 记录 / 助手 / 我的”四个入口，手机底部导航、平板侧边导航；即时采集与历史读取、本地保存和授权同步、观察记录、实验变化提醒、窗口摘要和 Hermes 问答。首页即时值仅来自 `live_device`，历史记录不填补采样空窗。

实验规则默认关闭，不预填医学阈值，未知质量参与须显式同意。血糖、血压、压力、HRV 是厂商协议返回值，医学准确性尚未核验；皮温不等于核心体温。三轴运动采集尚未接入此 App，ECG / 原始 PPG / RRI 没有已验证读取协议。当前版本不具备经验证的癫痫发作识别能力。

仓库包含应用与服务端的开发源码、合成测试和运行配置模板；不含凭据、真实健康记录、设备标识、实测截图、官方 APK 或反编译产物。发布构建目前使用开发签名；正式签名、卓易通后台能力、双真机跨网送达和长时间采集仍需单独验证。

本次未擅自选择开源许可证。图片资产的生成方式和参考来源见 `app/assets/images/provenance.json`；不要把项目来源说明理解为对第三方素材的授权。
