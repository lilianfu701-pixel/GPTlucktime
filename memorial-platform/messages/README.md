# 界面文案语言包

## 1. 覆盖范围

15 个语言包，对应 `lib/locale.ts` 的 `SUPPORTED_LOCALES`。
文档 07 §1 的四个发布批次全部包含，外加单列的 `pt-PT`。

`tests/unit/messages.test.ts` 强制以下不变量，缺一即构建失败：

- 每个受支持 locale 都有语言包，且不存在路由无法服务的多余文件；
- 所有语言包的键集与 `en.json` **完全一致**（缺键和多键都报错）；
- 没有空字符串；
- ICU 占位符（如 `{email}`）在所有语言中保持一致；
- 文档 04 §10 的 18 个错误码在每个语言中都有文案；
- 每个语言的 `meta.localeName` 用该语言自己书写且互不重复；
- 文件不含替换字符，且仍保有各自的文字系统。

最后一条是因为实际踩过：Windows PowerShell 5.1 以 ANSI 读取 UTF-8 文件，
越南语的声调符号被全部破坏，而文件**仍是合法 JSON、键也齐全**，
纯粹的键一致性检查完全发现不了。编辑语言包不要用 PowerShell 的
`Get-Content`/`Set-Content`。

## 2. 审校状态

`lib/locale.ts` 的 `localeReviewStatus()` 如实记录每个语言包是否经过母语者审校。

| 状态 | 语言 |
|---|---|
| `reviewed` | `en`、`zh-CN`、`zh-TW` |
| `needs_native_review` | 其余 12 种 |

标记为 `needs_native_review` 的语言包**文案完整、可以渲染**，但尚未由母语者
校对过语域。这是丧亲产品：字面意思正确而语域不当，比显示英文更伤人。
慰问语的敬体程度、对逝者的称谓、以及某个说法所暗示的仪式，各语言差别很大。

审校完成后请更新 `REVIEW_STATUS`，不要提前改。

## 3. 不属于这里的内容

**祭奠方式的名称不放在界面语言包里。** 数据模型有独立的 `ritual_translations`
表（文档 03 §5），每条翻译都要带来源、适用范围、审核人和审核时间，
且机器翻译不得进入已发布状态（文档 05 §7）。
把「上香」「献花」这类词放进这里会绕过整套审核流程。

界面语言包只放通用控件文案。

## 4. 新增语言

1. 在 `lib/locale.ts` 的 `SUPPORTED_LOCALES` 中加入该 locale；
2. 在 `REVIEW_STATUS` 中加入条目（新语言一律先标 `needs_native_review`）；
3. 复制 `en.json` 并翻译，键不可增删；
4. 若为 RTL 文字，加入 `RTL_LOCALES` 并补 375px 无横向溢出的 E2E 断言；
5. 运行 `npm test`，键一致性测试会指出任何遗漏。

不需要改动路由或组件代码。
