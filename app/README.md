# RareGuard 0.3.0

**唯一 APK 源工程：本仓库的 `app/`。** 所有 Android 适配、测试及 APK 构建均在此工程完成；外部厂商 Demo 仅为 SDK 参考资料，不作为应用源码或 APK 交付入口。

家庭夜间观察 App。Flutter 界面通过 Android 原生 BLE 前台服务连接 MR11，真实记录与家长观察先保存在本机，再按授权同步到项目公网服务。

## 页面与能力

- **今夜**：设备状态、即时心率/血氧/皮温、60 秒单项测量、实验夜间心率血氧交替采集、发作观察、报告与提醒。
- **记录**：设备事件和家长观察；发生时间与记录时间分别保存。
- **助手**：在应用内打开 Octop，使用 Dravet 项目助手管理单患者只读连接与会话。
- **我的**：戒指连接与历史、配对授权、实验规则和数据管理。

首页仅显示 `live_device` 即时读数。历史不填入最近采样、不填补采样空窗。血糖、血压、压力和 HRV 入口保留并标注厂商返回值及尚未核验的医学准确性。皮温不等同于核心体温。ECG、原始 PPG、RRI 暂无已验证协议。

三轴连续读取已在另一会话电脑端实测，本版本尚未接入运动采集。静置波动或手动抖动不能证明痉挛识别能力；单位、坐标标定、采样率和长时间覆盖仍待核验。

## Windows 构建

在本仓库的 `app/` 目录运行；Android 工具链按本机环境配置。

```powershell
$env:JAVA_HOME = '<path-to-jdk-17>'
$env:ANDROID_HOME = '<path-to-android-sdk>'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
flutter pub get
flutter analyze --no-pub
flutter test --no-pub
& .\scripts\check_core.ps1
flutter build apk --release --no-pub
```

APK：`build/app/outputs/flutter-apk/app-release.apk`；包名 `org.rareguard.rareguard`；版本 `0.3.0+3`；最低 API 26。沿用工程现有 debug 签名构建 release 测试包，正式发布签名尚未配置。当前 SHA-256：`32A952433762D696F97D69672B8BF08A1D43E37E4C87FB08244700AD36B229BF`。

```powershell
adb -s <device-serial> install -r .\build\app\outputs\flutter-apk\app-release.apk
```

## 数据与公网

采集路径为 `RingService → LocalStore → NativeController → Flutter`。Android Keystore 加密保存配对凭据，私有 SQLite 保存记录，网络失败保留待同步状态。摘要与离散图使用明确窗口，分页截断有说明；切换窗口清除旧摘要及问答，拒绝迟到结果回填。

- 病程管理页：`https://bingcheng.tongyimoheai.top/dravet`
- Octop：`https://octop.tongyimoheai.top/`
- 手机上传接口：`https://bingcheng.tongyimoheai.top/api/dravet/*`

从“我的 → 连接与测量”启动服务，再从“我的 → 服务与隐私”粘贴病程页生成的手机配对包。手机上传凭据由 Android Keystore 加密保存；Octop 与家长账号只在内嵌网页中分别登录，不把智能体 token 注入原生层。旧 Hermes `/v1/*` 不再是本 APP 的运行协议。

实验默认关闭、不预填医学阈值；用户填写边界、持续时长和允许间隔，未知质量参与须明确同意。没有数据或没有提醒不等于安全；查看确认不停止规则计时。

## 验证与待验边界

本轮 `flutter analyze` 无问题；19 项 Flutter 流程、35 项核心协议、47 项实验规则检查通过，Android 原生数据库/配对/队列单测通过。覆盖即时/历史隔离、无效质量、测量冲突、观察时间、旧队列隔离、幂等补传、换绑拒绝、窄屏和较大字号。

截图与独立评审见 `.impeccable/review/`；详细记录见 `docs/redesign-validation-20261011.md`。手机截图是在平板上模拟尺寸，不能代表卓易通真机。本轮界面检查不连接或采集戒指，避免抢占另一会话。

Mate 70 Pro+ / 用户报告 HarmonyOS 7 / 卓易通的本 App BLE、后台与锁屏接收待验；Octop 真机登录/会话、病程配对、跨网络查询、长时间采集覆盖与端侧响铃待实测。服务器事件记录不等同于远程推送，APP 当前不声称具备跨手机告警送达。

视觉 tokens 与组件见 `lib/design.dart`、`DESIGN.md`、`.impeccable/design.json`。图源和提示词见 `assets/images/provenance.json`。独立图片进入 App，六屏效果图仅作参考，图中示例数值不得进入生产数据。
