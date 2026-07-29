# 04. API 契约

## 1. 基本规范

- 前缀：`/api`
- 内容类型：`application/json`
- ID：UUID 字符串
- 时间：ISO 8601 UTC
- 输入校验：Zod
- 鉴权：安全、HTTP-only 会话 Cookie
- 写入接口：要求 `Idempotency-Key`
- 分页：游标分页，禁止无限深页码
- 关联 ID：接受或生成 `X-Correlation-Id`

成功响应：

```json
{
  "data": {},
  "meta": {
    "correlationId": "req_..."
  }
}
```

失败响应：

```json
{
  "error": {
    "code": "MEMORIAL_FORBIDDEN",
    "message": "You do not have permission to perform this action.",
    "fieldErrors": {}
  },
  "meta": {
    "correlationId": "req_..."
  }
}
```

公开错误信息不得包含堆栈、SQL、对象存储键、供应商原始响应或内部风险分数。

## 2. HTTP 状态约定

| 状态 | 使用场景 |
|---:|---|
| 200 | 查询或幂等重放成功 |
| 201 | 首次创建成功 |
| 202 | 异步导出、删除或媒体处理已接受 |
| 204 | 无响应体更新成功 |
| 400 | JSON 或参数格式错误 |
| 401 | 未登录或会话失效 |
| 403 | 已知资源但无操作权限 |
| 404 | 资源不存在，或私密资源对当前用户不可见 |
| 409 | 状态冲突、重复关系或幂等键冲突 |
| 410 | 已删除并处于清理状态 |
| 422 | 业务字段校验失败 |
| 429 | 超出频率限制 |
| 503 | 必需依赖暂不可用 |

对未受邀用户访问私密主页统一返回 404，避免泄露其存在。

## 3. 身份接口

### POST `/api/auth/email/request`

请求：

```json
{
  "email": "person@example.com",
  "locale": "zh-CN"
}
```

响应统一为 202，不透露邮箱是否已经注册。

### POST `/api/auth/email/verify`

```json
{
  "email": "person@example.com",
  "code": "123456"
}
```

成功后设置会话 Cookie。验证码十分钟过期，连续六次错误锁定挑战。

### POST `/api/auth/phone/request`

```json
{
  "phone": "+14155550100",
  "locale": "en"
}
```

当 `phone_auth_enabled=false` 或地区未开放时返回：

```json
{
  "error": {
    "code": "FEATURE_DISABLED",
    "message": "Phone sign-in is not available."
  }
}
```

第一阶段前台不调用此接口。

## 4. 追思主页接口

### POST `/api/memorials`

权限：已登录用户。

```json
{
  "relationship": "spouse",
  "primaryName": {
    "value": "王明",
    "locale": "zh-CN",
    "script": "Hans"
  },
  "aliases": [],
  "birthDate": {
    "value": "1948-00-00",
    "precision": "year"
  },
  "deathDate": {
    "value": "2026-07-20",
    "precision": "day"
  },
  "locations": [],
  "visibility": "public",
  "searchEngineIndexable": true,
  "relationshipStatementAccepted": true
}
```

响应：

```json
{
  "data": {
    "memorialId": "uuid",
    "slug": "wang-ming-uuidpart",
    "duplicateCandidates": []
  }
}
```

### PATCH `/api/memorials/{id}/privacy`

权限：所有者。

```json
{
  "visibility": "invite_only",
  "searchEngineIndexable": false,
  "confirmPublicExposure": false
}
```

转公开时 `confirmPublicExposure` 必须为 `true`。

### POST `/api/memorials/{id}/members/invitations`

权限：所有者或管理员。

```json
{
  "email": "relative@example.com",
  "role": "editor",
  "expiresInDays": 14
}
```

所有者角色不能通过普通邀请分配。

## 5. 内容和媒体

### POST `/api/memorials/{id}/tributes`

创建者可直接发布；访客根据主页设置进入 `pending_review`。

```json
{
  "title": "A story I remember",
  "body": "Content",
  "sourceLocale": "en"
}
```

### POST `/api/media/sign`

权限：具有相应主页内容编辑权。

```json
{
  "memorialId": "uuid",
  "fileName": "portrait.jpg",
  "contentType": "image/jpeg",
  "size": 2039412
}
```

响应包含短期上传 URL、必需请求头和 `mediaAssetId`。上传完成不代表公开可用；只有状态变为 `ready` 后才可展示。

## 6. 宗教与祭奠

### GET `/api/religion/recommendations`

查询参数：

- `religionId`
- `denominationId`
- `cultureIds`
- `country`
- `locale`

仅返回已发布规则、适用范围、兼容等级、解释和来源摘要。不确定或冲突结果不作为自动建议返回。

### PUT `/api/memorials/{id}/ritual-settings/{ritualVersionId}`

权限：所有者。

```json
{
  "enabled": true,
  "displayNameOverride": null,
  "allowAnonymous": false,
  "allowMessage": true,
  "moderationMode": "pre_review",
  "familyConfirmed": true
}
```

### POST `/api/memorials/{id}/commemorations`

```json
{
  "ritualVersionId": "uuid",
  "message": "We remember you.",
  "locale": "en",
  "anonymous": false
}
```

服务端必须验证：

- 当前访问者可访问主页；
- 仪式版本已被家属启用；
- 匿名和留言策略允许；
- 幂等键未被不同请求体使用；
- 未超出 IP、账号或主页限流；
- 当前访客未被该主页屏蔽。

## 7. 搜索

### GET `/api/search`

参数：

- `q`
- `birthYear`
- `deathYear`
- `country`
- `region`
- `locale`
- `cursor`
- `limit`，最大 50

响应只包含公开且未删除主页的安全摘要。SQL 查询本身必须包含公开状态条件，不能只在应用层过滤。

## 8. 举报和申诉

### POST `/api/reports`

```json
{
  "resourceType": "memorial",
  "resourceId": "uuid",
  "category": "identity_impersonation",
  "description": "Explanation",
  "contactEmail": "reporter@example.com"
}
```

### POST `/api/memorials/{id}/ownership-disputes`

创建私密申诉案件并返回证据上传入口。证据文件不复用普通媒体访问策略。

## 9. 导出和删除

### POST `/api/memorials/{id}/export`

权限：所有者或管理员。返回 202 和导出任务 ID。完成后通过短期签名 URL 下载。

导出不包含：

- 登录凭据；
- 私密申诉材料；
- 被屏蔽用户详情；
- 内部风险分数；
- 其他用户未授权的私密信息。

### DELETE `/api/memorials/{id}`

权限：所有者，要求二次确认和幂等键。返回 202，主页立即退出搜索和公开访问，恢复期后执行最终清理。

## 10. 稳定错误码

- `AUTH_REQUIRED`
- `SESSION_EXPIRED`
- `FEATURE_DISABLED`
- `INVALID_INPUT`
- `MEMORIAL_NOT_FOUND`
- `MEMORIAL_FORBIDDEN`
- `INVITATION_REQUIRED`
- `RELATIONSHIP_NOT_ELIGIBLE`
- `PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED`
- `DUPLICATE_CANDIDATE_FOUND`
- `RITUAL_NOT_ENABLED`
- `RITUAL_COMBINATION_PROHIBITED`
- `CONTENT_PENDING_REVIEW`
- `RATE_LIMITED`
- `IDEMPOTENCY_CONFLICT`
- `EXPORT_IN_PROGRESS`
- `CALENDAR_NOT_CONFIGURED`
- `DEPENDENCY_UNAVAILABLE`

