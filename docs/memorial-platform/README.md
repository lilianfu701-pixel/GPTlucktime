# 全球网上追思平台开发文档

版本：1.0  
日期：2026-07-29  
状态：可以开始第一阶段开发

## 文档目的

本目录是全球网上追思平台的开发入口，面向产品、设计、工程、测试、审核和运维人员。文档定义首版必须实现的业务规则、系统边界、接口约定和验收标准。

发生冲突时，按以下优先级处理：

1. 已批准的产品规格；
2. 本目录中的开发约定；
3. 详细实施计划；
4. 代码内注释。

发现文档和代码不一致时，不允许静默选择其中一个；应通过变更记录修正文档或实现。

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-product-requirements.md](01-product-requirements.md) | 产品定位、用户、功能、隐私和商业边界 |
| [02-system-architecture.md](02-system-architecture.md) | 技术选型、模块边界、数据流和可靠性 |
| [03-data-model.md](03-data-model.md) | 数据实体、关系、状态和数据生命周期 |
| [04-api-contracts.md](04-api-contracts.md) | API 规范、错误码、权限和幂等性 |
| [05-religion-culture-engine.md](05-religion-culture-engine.md) | 宗教、文化、祭奠方式及审核体系 |
| [06-security-privacy-moderation.md](06-security-privacy-moderation.md) | 身份、安全、隐私、举报和争议处理 |
| [07-i18n-accessibility-seo.md](07-i18n-accessibility-seo.md) | 多语言、RTL、无障碍和搜索引擎 |
| [08-testing-quality.md](08-testing-quality.md) | 测试分层、发布门槛和验收矩阵 |
| [09-deployment-operations.md](09-deployment-operations.md) | 环境、部署、监控、备份和故障处理 |
| [10-development-roadmap.md](10-development-roadmap.md) | 任务顺序、里程碑、交付物和完成定义 |
| [11-launch-decisions.md](11-launch-decisions.md) | 不阻塞基础开发但必须在上线前确定的事项 |

## 关联文档

- 产品设计规格：[`../superpowers/specs/2026-07-28-global-memorial-platform-design.md`](../superpowers/specs/2026-07-28-global-memorial-platform-design.md)
- 可执行实施计划：[`../superpowers/plans/2026-07-28-global-memorial-platform.md`](../superpowers/plans/2026-07-28-global-memorial-platform.md)

## 快速结论

- 技术语言：TypeScript
- Web 框架：Next.js
- 架构：模块化单体
- 数据库：PostgreSQL + Drizzle ORM
- 缓存与任务：Redis
- 媒体：S3 兼容对象存储
- 首发语言：英语、简体中文、西班牙语
- 首发创建者：逝者配偶、父母、子女或兄弟姐妹
- 默认隐私：公开并进入站内搜索
- 其他隐私：仅链接、仅受邀
- 宗教策略：宗教中立核心，由家属逐项开启祭奠方式
- 商业模式：基础版永久免费，高级权益预留，第一阶段不支付
- 手机登录：完整开发和测试，第一阶段前台隐藏

