# 03. 数据模型

## 1. 通用约定

- 主键：UUID；
- 时间：`timestamp with time zone`，以 UTC 保存；
- 金额：即使首版不支付，也使用最小货币单位整数；
- 软删除：核心内容保存 `deleted_at`；
- 版本：正文和宗教规则使用不可变版本记录；
- 审计：关键状态变化记录旧值、新值、操作者和原因；
- 枚举：应用和数据库迁移同时管理；
- 私密证据：独立表、独立对象存储前缀和独立访问审计。

## 2. 身份实体

### users

- `id`
- `display_name`
- `preferred_locale`
- `status`
- `created_at`
- `deleted_at`

### user_identities

- `id`
- `user_id`
- `provider`: `email | phone | google | apple`
- `provider_subject`
- `verified_at`
- `created_at`

`provider + provider_subject` 唯一。Google 和 Apple 账号使用提供方 subject，不使用邮箱作为长期主键。

### sessions

- `id`
- `user_id`
- `token_hash`
- `expires_at`
- `revoked_at`
- `ip_hash`
- `user_agent`

## 3. 追思实体

### deceased_people

保存逝者事实主体，一个主体可在合并流程中关联历史主页。

- `id`
- `birth_date`
- `birth_date_precision`
- `death_date`
- `death_date_precision`
- `gender_optional`
- `created_at`

日期精度：`day | month | year | approximate | unknown`。

### memorials

- `id`
- `deceased_person_id`
- `slug`
- `status`
- `visibility`: `public | unlisted | invite_only`
- `search_engine_indexable`
- `owner_user_id`
- `published_at`
- `deletion_requested_at`
- `purge_after`

### memorial_names

- `id`
- `memorial_id`
- `value`
- `locale`
- `script`
- `type`: `primary | former | native | transliteration | alias`
- `searchable`

### memorial_members

- `memorial_id`
- `user_id`
- `role`: `owner | admin | editor | reviewer | invited_visitor`
- `invited_by`
- `accepted_at`
- `revoked_at`

一个主页只能有一个当前所有者。

### relationship_claims

- `id`
- `memorial_id`
- `claimant_user_id`
- `relationship`: `spouse | parent | child | sibling`
- `statement_version`
- `status`
- `created_at`

## 4. 内容实体

- `biographies`
- `timeline_events`
- `tributes`
- `visitor_submissions`
- `content_versions`
- `content_translations`
- `media_assets`
- `media_albums`

所有翻译保存：

- 原始内容 ID；
- 原始语言；
- 目标语言；
- `human | machine`；
- 翻译状态；
- 审核者；
- 审核时间。

机器翻译不得覆盖原文，也不得冒充人工翻译。

## 5. 宗教文化实体

- `religions`
- `denominations`
- `cultural_traditions`
- `ritual_definitions`
- `ritual_versions`
- `ritual_sources`
- `ritual_translations`
- `ritual_compatibility_rules`
- `memorial_ritual_settings`
- `religious_calendar_dates`

`memorial_ritual_settings` 固定保存家属接受的 `ritual_version_id`，避免目录规则后来变化而无声改变现有主页。

兼容级别：

- `recommended`
- `optional`
- `needs_family_confirmation`
- `not_recommended`
- `prohibited_combination`

## 6. 祭奠实体

### commemorations

- `id`
- `memorial_id`
- `ritual_version_id`
- `actor_user_id`
- `anonymous`
- `locale`
- `status`: `visible | pending_review | rejected | hidden`
- `idempotency_key`
- `created_at`

`memorial_id + idempotency_key` 唯一。

### commemoration_messages

- `commemoration_id`
- `body`
- `moderation_status`
- `moderated_by`
- `moderated_at`

## 7. 搜索和治理

搜索：

- `search_documents`
- `search_aliases`
- `transliterations`
- `search_index_jobs`
- `duplicate_candidates`

治理：

- `reports`
- `ownership_disputes`
- `dispute_evidence`
- `moderation_cases`
- `moderation_actions`
- `blocked_users`
- `audit_logs`

重复候选只保存评分和依据，不自动合并。合并必须由授权人员执行，并保存原内容作者、旧主页 ID 和旧 slug 重定向。

## 8. 商业化预留

- `plans`
- `features`
- `plan_entitlements`
- `subscriptions`
- `orders`
- `memorial_entitlements`

有效权益解析顺序：

1. 主页显式覆盖；
2. 有效订阅；
3. 免费计划默认值。

首版不存在创建真实支付订单的公开接口。

## 9. 数据生命周期

| 数据 | 删除时行为 |
|---|---|
| 公开内容 | 立即隐藏，恢复期后清理 |
| 搜索文档 | 逻辑立即隐藏，异步物理删除 |
| 原始媒体 | 恢复期后删除 |
| 媒体衍生文件 | 恢复期后删除 |
| 数据导出 | 到期自动删除 |
| 申诉证据 | 按政策期限严格保留后删除 |
| 审计记录 | 仅保留合规和安全所需最小字段 |
| 祭奠记录 | 根据主页删除策略删除或匿名化 |

