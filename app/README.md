# RareGuard App 0.2.0

RareGuard 是家庭夜间观察实验 App。Flutter 界面通过 Android 原生 BLE 前台服务连接 MR11；即时读数、设备历史与家长观察保存在本机，按用户授权同步到服务端。

## 开发环境

已验证的工具链：Flutter **3.47.5**、Dart **3.13.4**、JDK **17**。Android 工程使用 Gradle wrapper **9.3.1**、Android Gradle Plugin **9.1.0**、Kotlin **2.4.0**，最低系统为 Android **API 26**。`compileSdk`、`targetSdk`、NDK 版本跟随 Flutter 配置。

安装 Flutter、Android SDK 和 JDK，将 `flutter` 加入 `PATH`，设置 `JAVA_HOME` 和 `ANDROID_HOME` 为各自本机安装目录。运行 `flutter doctor -v` 检查工具链，并接受需要的 Android SDK 许可。请使用仓库中的 Gradle wrapper；系统安装的 Gradle 无须与工程版本一致。

以下命令均在本目录 `app/` 执行。`android/local.properties` 由本机 Flutter 构建流程生成，其中 SDK 路径不能提交。

### Windows / PowerShell

```powershell
flutter pub get
flutter analyze --no-pub
flutter test --no-pub
& .\scripts\check_core.ps1
flutter build apk --release --no-pub
```

### macOS / Linux / Bash

```bash
flutter pub get
flutter analyze --no-pub
flutter test --no-pub
bash scripts/check_core.sh
flutter build apk --release --no-pub
```

两份 `check_core` 脚本都优先使用 `JAVA_HOME/bin`，未设置 `JAVA_HOME` 时使用 `PATH` 中的 `javac` 和 `java`。检查只编译独立 Java 协议与实验规则，不需要戒指、平板、Android SDK 或联网服务；测试帧和界面测试均为合成样本。

APK 输出：`build/app/outputs/flutter-apk/app-release.apk`。包名：`org.rareguard.rareguard`。当前 release 构建使用开发机的 **debug 签名**，用于开发测试；正式发布签名尚未配置。仓库不包含 keystore 或签名密码，不要提交这些文件。

连接自己的开发设备后，可运行 `adb devices`，再用 `adb -s <设备序列号> install -r build/app/outputs/flutter-apk/app-release.apk` 安装。请勿把真实序列号或健康数据写入仓库。

## 页面与数据流

- **今夜**：设备状态、即时心率/血氧/皮温、60 秒单项测量、心率与血氧交替实验采集、发作观察入口、报告与提醒。
- **记录**：设备事件及家长观察，分别保留发生时间和记录时间。
- **助手**：按明确时间窗口向真实 Hermes 提问，显示等待、失败和完成状态。
- **我的**：戒指连接、设备历史、服务配对、独立授权、实验规则和数据管理。

手机使用底部四入口；宽度达到 720dp 时使用侧边导航。界面入口和主题位于 `lib/`，原生 BLE 与存储位于 `android/app/src/main/java/org/rareguard/app/`，独立协议和规则位于 `org/rareguard/core/`。

采集路径：`RingService → LocalStore → NativeController → Flutter`。首页仅接纳 `live_device` 即时来源；`device_history` 留在历史记录中，不填补即时采样空窗。Android Keystore 加密保存配对凭据，应用私有 SQLite 保存本机记录。同步失败保留待上传状态，服务端明确确认批次后才标为已上传。

血糖、血压、压力和 HRV 保留厂商值入口，医学准确性尚未核验。皮温不能当作核心体温；ECG、原始 PPG、RRI 暂无已验证协议。三轴连续运动读取仍待接入本版本，尚未验证痉挛或癫痫发作识别能力。

## 服务配对与隐私

当前源码保留项目既有公开入口：

- API：`https://rareguard.tongyimoheai.top/api`
- 登录控制台：`https://rareguard.tongyimoheai.top/console`
- Hermes Web：`https://rareguard.tongyimoheai.top/hermes/?profile=dravet-night`

这些地址不授予访问权限。控制台与 Hermes Web 需要登录，App 业务数据需要一次性配对和相应授权。**开发和测试请使用自己部署的服务及测试家庭，不要连接生产家庭数据。** 从“我的 → 服务与隐私”填写自己的 HTTPS API 入口及该服务签发的配对码；保存的入口优先于源码默认入口。已配对设备更换家庭前应先导出所需记录并清除应用数据，避免将旧记录上传到其他家庭。

公开仓库不含服务器凭据、配对码、数据库、真实测量记录或个人设备截图。服务端凭据通过服务端本机环境配置；Hermes 凭据不写入 App。上传、AI 分析、远程提醒分别授权，默认 Hermes profile 为 `dravet-night`。现有 Hermes 公网反代依赖提供上游服务的电脑 Docker 与 SSH 在线；队友可使用自己的服务部署。

## 实验与验证边界

实验变化提醒默认关闭，心率/血氧边界与持续时间由用户填写，不预填医学阈值。未知信号质量参与实验需要明确同意。数据缺失不算恢复，没有数据或没有提醒不代表安全；查看提醒确认也不会停止规则计时。本 App 用于观察和工程验证，不能诊断癫痫或替代临床监护。

现有回归检查覆盖即时/历史隔离、无效质量、测量冲突、观察时间、窗口切换及迟到问答、窄屏和较大字号、连接页重新进入。独立 Java 检查覆盖协议解码、测量窗口及持续变化实验规则。运行上面的命令验证当前检出版本，真机 BLE 与长时间采集需另行实测。

本 App 在 Mate 70 Pro+ / 卓易通中的 BLE、后台采集与锁屏接收尚未完成真机验证；另一 App 能连接同一戒指不能代替本 App 验证。双真机跨网络送达、独立查看确认和长时间采集覆盖仍需实测。当前远程提醒为轮询，不是厂商系统推送。

视觉 tokens 位于 `lib/design.dart`。图片来源和 AI 生成提示词见 `assets/images/provenance.json` 及同目录的 `*.prompt.txt`；PNG 内也保留提示词元数据。图片曾使用官方 ECTRI 图像作参考，本仓库不包含官方 APK、反编译产物或参考原图，来源说明不构成第三方授权声明。
