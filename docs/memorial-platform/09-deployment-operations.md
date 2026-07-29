# 09. 部署与运维

## 1. 环境

必须分离：

- local；
- test；
- staging；
- production。

每个环境使用独立数据库、Redis、对象存储桶、OAuth 应用和供应商凭据。禁止使用生产数据填充开发环境。

## 2. 必需配置

```text
DATABASE_URL
REDIS_URL
APP_URL
SESSION_SECRET
S3_BUCKET
S3_REGION
S3_ENDPOINT
EMAIL_PROVIDER
SMS_PROVIDER
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
APPLE_CLIENT_ID
APPLE_PRIVATE_KEY
PHONE_AUTH_ENABLED
PHONE_AUTH_REGIONS
```

秘密只存储在部署平台的秘密管理中，不提交 `.env`。应用启动时验证必需配置；测试通过显式测试配置注入。

## 3. 部署顺序

1. 构建不可变应用版本；
2. 运行迁移兼容检查；
3. 备份生产数据库；
4. 执行向前迁移；
5. 部署 Web；
6. 部署 Worker；
7. 检查 readiness；
8. 执行冒烟测试；
9. 逐步放量；
10. 记录发布证据。

数据库回滚采用修复性向前迁移。不得在生产使用破坏性 `git reset` 或手工删除迁移历史。

## 4. 健康检查

- `/api/health/live`：进程仍在运行，不访问外部依赖；
- `/api/health/ready`：有限时地检查数据库和 Redis；
- 不在响应中暴露连接字符串、内部主机、堆栈或供应商信息。

## 5. 监控指标

Web：

- 请求量、错误率和延迟；
- 401、403、404、429 比率；
- 公开主页缓存命中；
- 搜索耗时；
- 媒体签名失败。

Worker：

- 各主题队列长度；
- 任务成功和失败；
- 重试次数；
- 死信数量；
- 最老待处理事件年龄。

业务安全：

- 登录挑战异常；
- 私密访问拒绝；
- 举报数量；
- 主页隐藏数量；
- 重复主页候选；
- 宗教规则停用；
- 数据删除积压。

## 6. 日志

结构化日志至少包含：

- 时间；
- 环境；
- 服务；
- correlation ID；
- actor ID 的安全表示；
- 资源类型和资源 ID；
- 稳定结果码；
- 耗时。

日志遵守敏感信息禁止清单，不记录验证码、令牌、申诉证据和完整私密正文。

## 7. 备份

- PostgreSQL 每日备份；
- 关键发布前备份；
- 对象存储启用版本或删除保护策略；
- 备份加密；
- 备份访问最小权限；
- 定期恢复到隔离数据库；
- 恢复测试验证主页、成员、仪式设置、审计和 outbox。

只生成备份但不执行恢复测试，不满足验收要求。

## 8. 故障处理

### 数据库不可用

- readiness 失败；
- 停止接受写操作；
- 不降级为绕过权限的缓存读取；
- 恢复后重放安全的幂等请求。

### Redis 不可用

- 登录和高风险限流默认失败关闭；
- 已授权公开读取可按明确策略降级；
- Worker 不确认未完成任务。

### 搜索故障

- 不影响主页真值和隐私；
- 搜索返回受控错误；
- 隐私过滤仍在数据库层；
- 恢复后重建索引。

### 媒体泄漏

- 立即撤销签名策略或对象访问；
- 切换主页为受限状态；
- 清除 CDN；
- 记录影响对象；
- 通知安全负责人；
- 根据法律政策通知受影响用户。

### 宗教规则错误

- 停用有问题版本；
- 阻止新主页使用；
- 通知已使用该版本的主页所有者；
- 保留历史和审核记录；
- 发布修订版本，不覆盖旧版本。

## 9. 功能开关

至少包括：

- `phone_auth_enabled`
- `phone_auth_regions`
- `oauth_google_enabled`
- `oauth_apple_enabled`
- `machine_translation_enabled`
- `public_search_enabled`
- `anniversary_notifications_enabled`
- `premium_ui_enabled`

高风险开关变更必须审计，并支持快速关闭。

