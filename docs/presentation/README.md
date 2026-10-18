# RareGuard 路演公开归档

源稿日期：2026-10-16。公开归档：2026-10-19。

| 内容 | 文件 |
| --- | --- |
| 可编辑源稿 | [index.html](index.html) |
| 常规 16:9 | [PDF](RareGuard-Dravet-16x9.pdf)、[PPTX](RareGuard-Dravet-16x9.pptx) |
| 15.3:5.3 超宽 | [PDF](RareGuard-Dravet-wide.pdf)、[PPTX](RareGuard-Dravet-wide.pptx) |

这是产品发布式 A 方向，11 页，包含病程云端服务、夜间工作台和 Octop 项目智能体。双击 HTML 可查看常规版，加 `?wide=1` 查看超宽版；方向键翻页。

公开版排除了 Octop 原截图底部的账户区域，并从同一 HTML 重新导出两个比例。原始未处理截图、旧稿、缓存与检查中间文件不在归档中。布局和产品叙事保持原稿，未新增真实设备或临床验证结论。

## 资料口径

- RareGuard App 页面和产品插画是设计示例，来源为项目已有生成素材。
- 病程页面为真实界面的合成测试档案，不含实际患者记录或有效凭据。
- Octop 图片只展示产品区域，入口与快捷操作不代表完成了真实患者绑定后的查询。
- 真实戒指到手机上传、真实 Octop 对话、整夜 BLE 覆盖与端侧响铃仍待验收。演示不等于临床验证。

素材来源：戒指、夜间插画、App UI 与助手头像来自项目 2026-10-10 设计资产；病程截图来自 2026-10-15 合成界面验收；Octop 产品区域来自 2026-10-16 页面截图。资产校验值见 [清单](../archive-assets.json)。保留原有素材来源边界，不赋予第三方素材额外许可。

## 重导出

```sh
python -m pip install -r docs/presentation/requirements.txt
python -m playwright install chromium
python docs/presentation/export_deck.py
node docs/presentation/export_pptx.mjs
```

PPTX 导出需要本机可解析的 `@oai/artifact-tool`，脚本将草稿写入仓库根目录 `.archive-build/`。公开成品经过结构检查与独立定稿，已经一同归档，无需安装工具即可查看。脚本不包含个人路径或固定开发服务器端口。

PPTX 每页使用整页渲染图保证版式一致，文字不是独立可编辑对象；修改文案与布局请编辑 HTML，再导出。超宽版保留中心内容与两侧安全边。显示比例与字体仍需在演示设备确认。
