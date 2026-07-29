# 依赖安全说明

记录 `package.json` 中偏离实施计划原始钉版的原因，以及已知但暂不修复的告警。
每次升级依赖后重新执行 `npm audit` 并更新本文件。

## 1. 相对实施计划的版本调整

实施计划写于 2026-07-28，其中若干钉版在开始开发时已不可用或含已知漏洞。

| 依赖 | 计划钉版 | 实际钉版 | 原因 |
|---|---|---|---|
| `next-intl` | 4.3.12 | 4.13.4 | 4.3.12 的 peer 范围只到 `next@15`，与 `next@16` 冲突，安装直接失败 |
| `next` / `eslint-config-next` | 16.2.6 | 16.2.12 | 16.2.6 存在多项 high 级公告，含中间件绕过、Server Actions SSRF 与响应体缓存混淆 |
| `vitest` | 4.0.3 | 4.1.10 | 4.0.x 存在 critical 公告：Vitest UI 服务监听时可读取并执行任意文件 |
| `@aws-sdk/client-s3` `@aws-sdk/s3-request-presigner` | 3.910.0 | 3.1097.0 | 3.910.0 经 `@aws-sdk/xml-builder` 引入 `fast-xml-parser@5.2.5`（critical，多个实体展开 DoS 与绕过）。新版本已完全移除该依赖 |

## 2. overrides 及其理由

```json
"overrides": {
  "esbuild": "^0.25.12",
  "postcss": "^8.5.25",
  "sharp": "^0.35.3"
}
```

- **esbuild**：`drizzle-kit@0.31.10`（当前最新版）仍依赖已废弃的 `@esbuild-kit/esm-loader`，后者锁定含开发服务器越权读取漏洞的 esbuild。上游无新版可用，只能提升传递依赖。
- **postcss**：`next@16.2.12` 内部钉在 `8.4.31`，含 XSS 与 sourceMappingURL 路径穿越公告。`8.5.x` 为同一次版本线，兼容。
- **sharp**：`next` 内部钉在 `0.34.5`，继承 libvips 的 4 个 CVE。平台会处理用户上传的图片，属于真实攻击面，必须提升到 `0.35.x`。

`npm audit fix --force` 对上述三项给出的“修复”是把 `next` 降级到 9.3.3，不可接受。

## 3. 已知且暂不修复的告警

**`brace-expansion` — GHSA-mh99-v99m-4gvg（high，DoS）**

- 引入路径：`eslint-config-next` → `eslint-plugin-import` / `eslint-plugin-jsx-a11y` / `eslint-plugin-react` → `minimatch@3` → `brace-expansion@1.x`
- 影响范围：仅 devDependency（lint 工具链），不进入运行时产物。
- 触发条件：需要攻击者控制 glob 模式。本仓库的 glob 只来自 `eslint.config.mjs`，由我们自己编写。
- 为何不修：
  - 该公告只承认 `5.0.8` 为修复版本，`1.x` 分支没有补丁；
  - 强制 `brace-expansion@5` 会让 `minimatch@3` 崩溃（`TypeError: expand is not a function`），lint 完全不可用；
  - 升级到 `eslint@10.8.0` 会让 `eslint-plugin-react` 崩溃（`contextOrFilename.getFilename is not a function`），该插件由 `eslint-config-next` 捆绑，无法单独绕开；
  - `npm audit fix --force` 给出的方案是把 `eslint-config-next` 降到 `0.2.4`。

**复查条件**：`eslint-config-next` 发布支持 eslint 10 的版本后重新评估，届时应可一并清除。
