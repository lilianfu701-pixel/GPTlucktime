# GPTlucktime 命盘推演

GPTlucktime 是一个以出生地历史民用时间为起点的静态八字命盘程序。程序先处理 IANA
时区、夏令时、历史地方平时和真太阳时，再按精确节气瞬间推导四柱及已经审核的静态事实指标。

当前版本只生成出生固定盘，不提供吉凶判断、人生预测或自动解释。

## 本地运行

项目要求 Node.js **20.9.0 或更高版本**（`package.json` 中固定为
`engines.node: ">=20.9.0"`），并使用随 Node 安装的 npm。

```bash
npm ci
npm run dev
```

开发服务器默认位于 `http://localhost:3000`。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run lint` | 执行 TypeScript 严格类型检查 |
| `npm run test:run` | 运行全部 Vitest 单元与组件测试 |
| `npm run test:coverage` | 运行测试并检查 core 覆盖率门槛 |
| `npm run build` | 生成生产构建 |
| `npm run start` | 启动已经构建的生产服务器 |
| `npm run test:e2e` | 重新构建并运行 Playwright Chromium 端到端测试 |

首次运行浏览器测试前，如本机没有 Chromium，可执行：

```bash
npx playwright install chromium
```

## 架构

数据流保持单向，客户端不重新实现命理规则：

1. `BirthIntakeForm` 负责轻量同步检查，并通过 Server Action 完成权威 IANA/DST 校验。
2. `ChartSessionProvider` 只在当前 React 页面会话内存保存待处理的规范化输入。
3. `generateChart` Server Action 调用 server-only `chart-service`，不记录或持久化输入。
4. `buildChartContext` 按固定顺序编排输入规范化、民用时间、真太阳时、节气、四柱和指标。
5. `toChartViewModel` 把成功的不可变 `ChartContext` 映射成无生活地信息的展示合同。
6. `/chart` 只消费展示合同；成功后立即清除待处理出生输入，刷新后不会恢复命盘。

核心编排顺序：

```text
normalizeBirthInput
  -> resolveCivilTime
  -> calculateSolarTime
  -> locateSolarTerms
  -> calculatePillars
  -> deriveStaticIndicators
  -> immutable ChartContext + trace + warnings + versions
```

## 已实现指标

- 四柱：年、月、日、时干支及六十甲子索引；年/月边界使用真实节气瞬间。
- 十神：以日主为基准，分别记录显干和地支藏干十神。
- 五行：显干与藏干分开计数。
- 干支关系：天干合冲，地支六合、六冲、害、破、刑、三合、三会，并保留规则 ID 和柱位。
- 表驱动事实：纳音、旬空、十二长生、月令。
- 九星气学：静态本命星和月命星。
- 时间审计：民用时间、UTC、总/DST/标准偏移、标准子午线、经度修正、均时差、真太阳时、JDN、相邻节气、柱边界、warnings、版本和脱敏 trace。

神煞规则当前未启用，页面会明确显示“基础神煞规则尚未启用”，不会伪造命中项。

## 算法版本

命盘结果内置并展示以下版本标识，便于复算和审计：

| 层级 | 当前标识 |
| --- | --- |
| 应用合同 | `gptlucktime@0.1.0/chart-context-v1` |
| 静态规则表 | `bazi-static-rules@1.0.0` |
| 真太阳时 | `astronomy-engine@2.1.19/true-solar-time-v1` |
| 历史时区数据 | `timezonecomplete@5.15.1/tzdata@1.0.49` |
| 节气搜索 | `astronomy-engine@2.1.19/search-sun-longitude-v1` |

这些标识集中定义于 `src/core/versions.ts`。升级依赖或规则表时，应同步更新版本标识和黄金测试。

## 准确性边界

- 本项目使用 `timezonecomplete` 的历史 TZ data 解析本地墙上时间，不使用宿主 `Intl`/`Date` 推断历史时区。
- DST 缺口会拒绝计算；DST 重复时刻必须明确选择 earlier 或 later。
- 真太阳时使用标准 UTC 偏移对应的标准子午线、出生地经度修正和 Astronomy Engine 均时差；夏令时偏移不会被误算入经度修正。
- 历史 LMT 秒级偏移会保留为 `±HH:MM:SS`，不会静默四舍五入成整分钟。
- 节气通过太阳黄经搜索获得，不使用固定日期表。年柱与月柱比较出生实际 UTC 瞬间；日柱与时柱使用真太阳时墙上日期和时刻。
- 当前默认真太阳时午夜换日，不提供“子初换日”等流派选项。
- 支持的真太阳年份为 **0002 至 9998**。边界之外返回 `UNSUPPORTED_DATE_RANGE`，不继续天文计算。
- 约略或未知出生时间、接近节气/午夜/双小时边界等情况只产生不确定性 warning，不自动改写结果。
- 历史行政边界、出生地经纬度误差、来源时钟误差，以及不同命理流派规则都可能造成差异。结果应结合可核验出生档案和明确采用的规则版本复查。

## 隐私

- 出生资料会发送到服务器实例内存，用于时间校验和本次静态计算。
- 客户端只在当前 React 页面会话内存保存待处理资料。
- 应用不会把出生资料写入 `localStorage`、`sessionStorage`、Cookie 或数据库，也不会记录出生资料或客户端 IP。
- 成功生成后会清除待处理输入；刷新或关闭页面会清除客户端结果。
- 可选生活地原样保留在输入合同中，但不参与出生固定盘，也不会进入展示视图模型或脱敏 trace。

查询参数、URL 和页面持久化中均不携带出生资料。生产环境仍应按组织要求配置日志脱敏、访问控制和数据处理声明。

## 非预测范围

当前版本不实现或不输出：

- 喜忌、用神、旺衰、格局、身强身弱和吉凶断语；
- 大运、流年、流月、流日、流时等动态层；
- 年家、月家、日家动态飞星；
- 未审核的神煞规则；
- 医疗、法律、财务、婚恋或其他现实决策建议。

本项目输出的是确定规则下的静态历法和命理事实，不是科学预测或专业意见。

## 限流

服务器使用有界、单实例内存固定窗口限流器，客户端 key 优先读取 Vercel 的
`x-vercel-forwarded-for`，再回退到 `x-forwarded-for` 首个地址，最后使用 `anonymous`。
限流器不记录地址或输入内容。

| 接口 | 限制 | 最大跟踪 key |
| --- | --- | --- |
| 出生时间权威校验 | 每个 key 每分钟 30 次 | 5000 |
| 静态命盘生成 | 每个 key 每分钟 10 次 | 5000 |

该限流只对当前 Serverless 实例生效，冷启动会重置，不能替代全局防护。生产部署应叠加
Vercel Firewall 限流和平台级异常流量监控。

## Vercel 准备

仓库包含最小 `vercel.json`，声明 Next.js 框架并为所有路由设置防 MIME 嗅探、点击劫持、
Referrer Policy 和禁用摄像头/麦克风/定位的 Permissions Policy。当前应用不需要环境变量。

计划生产域名为 **`gpt.lucktime.net`**。本地准备完成后，在 Vercel 项目设置中添加该域名，
并严格采用 Vercel 控制台当时显示的 DNS 记录完成验证。自定义域名不写入 `vercel.json`，
因此预览部署和本地构建不会意外占用生产域名。

推荐的 Vercel 检查项：

1. Framework Preset 使用 Next.js，项目根目录为仓库根目录。
2. Install Command 使用 `npm ci`，Build Command 使用 `npm run build`。
3. 部署前确认 `npm run lint`、`npm run test:coverage`、`npm run build` 和 `npm run test:e2e` 全部通过。
4. 配置 Vercel Firewall 的全局限流，避免只依赖单实例内存 limiter。
5. 添加 `gpt.lucktime.net` 后按控制台提示配置 DNS 和 HTTPS，确认后再切换正式流量。

本任务只完成本地发布准备，不执行部署，也不修改远端仓库。
