# 02. 系统架构

## 1. 架构选择

首版采用 TypeScript + Next.js 模块化单体。所有领域在一个应用中部署，但业务逻辑、数据表、接口和权限保持清晰边界。

选择理由：

- 页面渲染和 SEO 能力适合公开追思主页；
- 前后端共享类型和校验；
- 初期部署简单；
- 开发和运维成本低于微服务；
- 搜索、媒体、通知和审核以后可以独立拆分。

## 2. 系统拓扑

```text
浏览器
  |
CDN / WAF / DDoS 防护
  |
Next.js Web 应用
  |-- PostgreSQL：事务、全文搜索、审计与任务发件箱
  |-- Redis：缓存、限流、验证码状态和任务队列
  |-- S3：媒体、导出文件和私密申诉材料
  |-- Worker：媒体处理、通知、索引、导出和清理
  `-- 第三方：邮件、短信、Google、Apple
```

## 3. 模块边界

| 模块 | 职责 | 不拥有 |
|---|---|---|
| auth | 身份、会话、登录渠道 | 主页权限 |
| memorials | 逝者、主页、成员和隐私 | 宗教规则 |
| permissions | 统一授权决策 | 数据持久化 |
| content | 生平、时间线、文章和翻译 | 媒体文件 |
| media | 上传、扫描、转码和签名访问 | 内容审核结论 |
| religion | 宗教、文化、仪式和历法 | 家属互动记录 |
| commemorations | 祭奠、留言、幂等和通知事件 | 仪式定义 |
| search | 索引、查询和重复候选 | 主页真值 |
| governance | 举报、争议、合并和封禁 | 登录认证 |
| entitlements | 套餐和有效权益 | 支付处理 |
| audit | 不可变操作记录 | 业务状态 |

API 路由只完成认证、输入校验、调用领域服务和映射响应，不直接执行 Drizzle 查询。

## 4. 共享接口

```ts
export type Result<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type Actor = {
  userId: string | null;
  platformRole: "user" | "reviewer" | "super_admin";
};
```

领域服务：

- 接受明确的 `Actor`；
- 使用 Zod 校验后的输入；
- 返回稳定错误码；
- 不抛出可预期的业务异常；
- 事务内写入审计和 outbox；
- 外部副作用交给 Worker。

## 5. 一致性策略

强一致：

- 主页隐私和访问判断；
- 成员权限；
- 祭奠是否允许；
- 宗教仪式是否启用；
- 申诉期间的限制状态；
- 权益配额。

最终一致：

- 搜索物理索引；
- 通知；
- 媒体衍生文件；
- 数据导出；
- 搜索引擎缓存。

隐私变更必须先同步改变主页真值和访问判断，再异步清理索引，不能依赖搜索任务完成后才保护内容。

## 6. 事务发件箱

跨模块异步动作使用数据库 outbox：

1. 业务状态和 outbox 事件在同一事务提交；
2. Worker 锁定可用事件；
3. 执行幂等副作用；
4. 成功后写 `processed_at`；
5. 失败按指数退避；
6. 达到上限进入死信记录。

主要主题：

- `memorial.created`
- `memorial.privacy_changed`
- `search.index`
- `search.remove`
- `media.process`
- `commemoration.created`
- `notification.send`
- `export.requested`
- `memorial.purge`

## 7. 缓存规则

- 公开主页允许短期 CDN 缓存和按标签失效；
- 仅链接主页不得进入公共共享缓存；
- 仅受邀页面统一 `private, no-store`；
- 权限判断结果不跨用户缓存；
- 宗教目录可按版本缓存；
- 隐私变更必须主动失效相关页面缓存。

## 8. 可扩展边界

满足以下条件之一才考虑拆服务：

- 搜索负载明显影响核心事务数据库；
- 媒体任务需要独立弹性扩缩；
- 通知量需要独立队列和供应商路由；
- 审核团队需要独立部署节奏；
- 单体部署无法满足已测量的可用性目标。

不以“未来可能很大”为理由提前拆微服务。

