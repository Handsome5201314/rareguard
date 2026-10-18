# 开源参考与复用记录

核验日期：2026-10-14。通过 `agent-reach` 的 GitHub 路由使用 `gh repo view` 核验仓库和许可证，再以 `git clone --filter=blob:none --no-checkout --depth=1` 拉取，按实际存在的文件稀疏检出。以下目录均位于被 Git 忽略的 `references/`，不进入应用构建或发布包。未运行上游安装、构建、数据库、容器或其他仓库脚本。

| 上游 | 实际固定提交 SHA | 许可证及原始权利人 | 本地参考目录 |
| --- | --- | --- | --- |
| [EzekielTheMad/healthtrack](https://github.com/EzekielTheMad/healthtrack) | `db80b11bc034537b84abababf4c9967bf81a6b3d` | MIT；Copyright (c) 2026 EzekielTheMad | `references/healthtrack/` |
| [medplum/medplum](https://github.com/medplum/medplum) | `48cf3559f79563ca6343a8970e8619fbacdb2806` | Apache-2.0；Orangebot, Inc. and Medplum contributors，另保留根目录 `NOTICE` | `references/medplum/` |
| [potalora/strand](https://github.com/potalora/strand) | `e5f1381a8b22814cf2f7cea4831c10d3579b106f` | MIT；Copyright (c) 2026 Pedro Otalora | `references/strand/` |

## 本轮参考的内容与边界

- **HealthTrack**：检出根 README、LICENSE、API 文档，家属档案与只读分享仓储、相关路由和档案切换组件。参考家属归属、不可由客户端指定 owner、越权读取返回 404、公开分享 token 作为凭证和档案切换的流程。首版没有照搬其家庭委托、账户成年转移或全套通用健康领域模型。
- **Medplum / Foo Medical**：检出根 README、LICENSE.txt、NOTICE，`examples/foomedical/`（排除 `.env*`）、`packages/react/src/ResourceTimeline/` 和访问控制文档。参考诊断报告与时间线分离、资源历史与变更呈现，以及服务端对每类资源实施归属限制的原则。该提交不存在 `packages/react/src/ObservationTable/`，未虚构该组件。首版没有引入 Medplum 运行时、FHIR 服务器或其示例患者数据。
- **Strand**：检出根 README、LICENSE，时间线 API / schema / service、记录与版本 / provenance 模型、时间线页面和设计说明。参考原始资料、结构化记录、来源、修订版本彼此分离。首版没有引入其 AI 摘要、文档抽取或医疗知识推断。

**复用方式**：本轮应用代码为项目自行实现；三个仓库仅作为本地只读设计和源码参考，尚无上游源代码、图标、截图、文案或静态资源复制到 `family-web/web/` 应用代码。不能将“已拉取参考源码”表述为“已集成上游产品”。现有评分核心沿用本项目原有实现。

## 后续实际复制时的要求

若后续复制或改编上游的文件或实质性代码片段，必须在同一改动中补充源仓库、固定 SHA、原始路径、目标路径、改动说明与许可证，并保留相应版权声明。MIT 需随副本保留原始版权和许可文本；Apache-2.0 需附许可证、保留适用声明、注明修改并处理适用的 NOTICE。仅更新依赖清单不足以完成代码复制的署名。

本轮未拉取或混入 OpenHealth、Fasten 等 AGPL/GPL 项目代码。许可证清单只反映上述固定提交的已核验根许可证，不构成上游未来版本或第三方依赖的统一授权。

## 可重现核验

在对应参考仓库运行 `git rev-parse HEAD` 可核对 SHA，运行 `git sparse-checkout list` 可核对实际检出范围。三个仓库保持原始许可证；Medplum 同时保留 `NOTICE`。应用构建配置仅指向本项目的 `family-web/web/`、`server/src/shared/` 和现有依赖，不应扫描 `references/`。
