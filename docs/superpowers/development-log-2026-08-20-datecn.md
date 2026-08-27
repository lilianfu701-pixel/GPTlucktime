# DateCN 开发记录与归档（更新至 2026-08-26）

## 1. 项目位置

- 对外域名：`datecn.org`
- 品牌：**DateCN**
- 独立工作区：`C:\Users\zexim\Documents\lucktime\.worktrees\global-dating-platform`
- 应用目录：`dating-platform`
- 独立分支：`codex/global-dating-platform`
- 本地可见预览：`http://localhost:52943/zh/demo/discover`

该工作区与以往工作隔离，未合并到主分支，未部署到生产环境。

## 2. 十五阶段完成状态

原实施计划共有 15 个阶段，不是 13 个。截至本记录，1—15 阶段的代码实现与本地验收均已完成：

1. 账户、登录、会话、身份验证与安全策略。
2. 用户资料、照片、偏好和隐私设置。
3. 搜索发现、候选快照、喜欢、收藏、匹配和访问记录。
4. 私信、消息历史、回执、实时连接和断线恢复。
5. 免费/付费会员权益与用量限制。
6. Stripe 套餐、结账、订阅、退款、争议和对账流程。
7. 举报、隔离、风险限制、证据、申诉和人工审核。
8. 六角色运营后台、MFA、双人审批、审计和后台任务。
9. 敏感导出、对象存储、自动清理和可靠消息投递。
10. 国际化、通知、隐私导出和账号删除工作流。
11. DateCN 暖金视觉首页及可见演示版。
12. 注册登录、发现匹配、资料、消息、会员中心和移动端界面。
13. 中英文隐私/通知完整流程及前向迁移。
14. 安全错误边界、敏感信息脱敏、可观测性和限流加固。
15. 发布前门禁、备份恢复验证、会员/订阅/审核真实浏览器验收。

## 3. 最后阶段主要提交

- `f8f95b0`、`f8b57cc`、`22c2972`：安全与可观测性基线及加固。
- `46b78eb`、`51d7996`：会员与审核验收界面。
- `f18f1ce`、`ce6cb4a`、`12ac503`：会员、订阅、审核、无障碍和移动端本地 E2E。
- `98f0b99`、`aa8c86a`：发布门禁、备份恢复及真实实时断线重连。
- `a60b669`、`8a9da47`：数据库清理保护与本地验收环境隔离。
- `f6d1f8d`：申诉复核原子/幂等处理、流式正文限制及重试稳定性。
- `1938884`：分离普通单元测试与浏览器测试，并补齐发现页路由测试环境。

## 4. 已验证结果

- 本地总验收通过：TypeScript、ESLint、生产构建、Drizzle 检查、Playwright 9/9。
- 会员流程通过：注册验证、资料、喜欢匹配、消息、真实 Socket.IO 停止/重启、离线消息补齐、屏蔽。
- 订阅流程通过：本地测试结账、签名回调、Plus 权益、取消、全额退款和权益失效。
- 审核流程通过：举报、分流、限制、案件结案、会员申诉、第二审核员改判、审计时间线和恢复互动。
- 桌面/移动端无障碍定向检查 6/6 通过；这是定向验收，不等同于完整 WCAG 审计。
- 最后修复聚焦测试 5 文件 / 19 项通过，TypeScript、ESLint 和审核浏览器流程通过。
- 2026-08-24 收尾全量回归：130 个测试文件通过、8 个环境门禁跳过；821 项通过、25 项按外部环境条件跳过；TypeScript 与相关 ESLint 检查通过。
- 本地验收会丢弃宿主机生产网址、数据库、Redis 和支付密钥，只允许回环地址和惰性测试值。
- 数据库恢复清理需要严格测试库命名、回环地址、源/目标不同，并要求确认值与目标库名完全一致。

## 5. 尚未完成的外部发布验收

以下不是代码缺失，而是当前电脑没有外部测试基础设施，因此发布门禁会按设计失败并阻止上线：

- `TEST_DATABASE_URL` 与独立的 `TEST_RESTORE_DATABASE_URL`。
- PostgreSQL 的 `pg_dump`、`pg_restore`、`psql` 工具。
- Stripe 测试模式密钥、Webhook 密钥、测试价格 ID 和 HTTPS 测试回调地址。

未执行真实外部 PostgreSQL 恢复或 Stripe 提供商验收；未写入真实密钥、生产数据或真实用户；未启用真实收费。

## 6. 免费 Vercel 兼容阶段（2026-08-25）

### 提交与功能

- `be392f7`：增加已授权的 HTTP 消息回执写入接口。
- `1e66b6a`：增加免费层消息轮询；只轮询当前会话，默认约 2 秒一次，页面隐藏时暂停，恢复可见后立即补齐，并延续 delivered/read 回执队列。
- `6d2fb05`：在既有存储边界后增加私有 Vercel Blob 适配，并强制 Blob/S3 二选一。
- `e337119`：增加受保护的合成通知邮箱；只接受 `@datecn.test`，Redis 加密保存最长 15 分钟，以 `GETDEL` 一次性读取，并要求访问码。
- `77c9b7a`：所有页面由服务端免费测试标志控制显示中英文全局横幅。
- `c890383`：隔离免费测试收件人校验，修复 Better Auth PostgreSQL 集成测试被 `server-only` 导入阻断的回归。

独立规格复查和代码质量复查已覆盖上述兼容改造与修复。免费测试环境禁止真实 Stripe、邮件、短信和实名认证配置，不接收真实用户或个人信息；私有 Blob 令牌、数据库、Redis 和访问码均保持服务端边界。

### 本轮本地验证

- 默认并发 `npm test` 实际结果：145 个文件中 129 个通过、8 个失败、8 个按环境门禁跳过；951 项中 888 项通过、38 项因并发 PGlite 超时及连带断言失败、25 项跳过；总时长 161.61 秒。该轮失败证据已保留，未把失败标记为通过。
- 完整单 worker `npm test -- --maxWorkers=1 --no-file-parallelism` 实际结果：145 个文件中 137 个通过、8 个跳过；951 项中 926 项通过、25 项跳过、0 项失败；总时长 631.64 秒。
- `npm exec -- tsc --noEmit`、全量 `npm run lint`、使用纯占位 HTTPS 免费测试环境的 `npm run build`、`npm exec -- drizzle-kit check` 均以 0 退出。构建完成全部应用路由与 API 路由编译；没有配置或调用外部 Stripe、邮件、短信或实名认证服务。
- 390 像素响应式检查目前只有代码 contract 测试与生产构建证据；真实浏览器、真实部署地址的 390 像素 smoke 尚未执行，不能视为已通过部署验收。

已知轻微边界：免费测试 redirect 输入限制为 4096 字节，而最终 URL 还受完整 envelope 编码边界约束。正常界面产生的短路径不受影响；超长输入仍应在真实部署 smoke 中作为负向用例复核。

### 外部状态与硬阻塞

- 2026-08-25 约 01:45 PT 的 Vercel Hobby 用量只读记录为 Fluid Active CPU `4h26m / 4h`，仍超过免费额度，因此当前禁止创建资源或部署。
- 2026-08-25 08:17 PT 再次只读刷新后为 `4h25m / 4h`，仍超出免费上限 25 分钟；因此继续保持零资源创建、零部署、零付费变更。
- 尚未创建 Vercel 项目、Neon 数据库、Upstash Redis 或 Blob 存储；未填写银行卡、未开通试用或付费服务、未部署网站、未修改 DNS。
- 既有只读检查记录：`datecn.org` 与 `www.datecn.org` 当前均为 Cloudflare 代理的 A 记录，值为 `178.128.54.40`。在 Vercel 临时地址完成验收、取得项目专属 DNS 值并获得用户对最终 diff 的明确确认前，不得更改。
- 云端迁移、合成 seed、临时 URL 桌面/390 像素真实浏览器 smoke、配额复核、回滚演练和域名切换均待后续 provisioning/domain 计划执行。

### Task 6 质量复核修正

- Task 6 首次质量复核结论为 `Ready: No`：被引用的 provisioning 计划仍混用 pnpm/corepack、个人账号与真实 team scope 名称不一致，并硬编码猜测临时 Vercel URL；runbook 的迁移说明也没有把目标数据库确认与执行做成同一 fail-closed 门禁。
- 修正后，provisioning 计划与 runbook 全部以本项目 npm/package-lock 工作流为准；一次性 Vercel CLI 使用 npm cache，不写项目依赖，并统一 scope 为 `lilianfu701-pixels-projects`。`APP_URL` 与 `BETTER_AUTH_URL` 只能使用项目创建后 Vercel 页面显示的精确 HTTPS origin，禁止从项目名猜测。
- 先前内联命令声称已拒绝“全部 `127.*`”，但该说法没有独立实现和自动化边界测试支撑，现予撤回。受测试的 `scripts/run-free-test-migration.mjs` 取代内联代码：仅接受显式安全 `sslmode` 的 `postgresql:` Neon 子域，拒绝 Neon 根域、尾点、任何 IP、`127.1`/完整 `127.*`、`0.0.0.0`、IPv4-mapped IPv6、localhost 和其他域；只在当前 Node 进程加载 gitignored `.env.vercel.local`。
- 新门禁要求 `--expected-host`、`--expected-database` 与 `--check` 或精确 `--confirm=datecn-free-test` 参数。只有目标精确匹配后才输出 host/database；CHECK 不 spawn，确认模式才以 `shell: false` 和固定参数数组启动 npm。所有 URL/路径解码/字段错误只输出固定脱敏错误，编写和验证期间没有连接数据库或执行迁移。
- `.env.example` 已明确其 localhost、MinIO 和 websocket 非空值仅供独立本机服务使用。当前代码不会在免费模式下自动拒绝 `REALTIME_PUBLIC_URL`，因此发布者必须在 Vercel 删除或留空；非空即门禁失败。
- 命令语法复核使用本机 `npm exec --help` 和 Vercel 官方 CLI/link/deploy 文档，未执行 Vercel CLI。迁移脚本依照红绿 TDD 新增 focused tests：首次 RED 因实现缺失为 1 file failed/0 tests；最小实现后暴露并修正数据库路径解析错误，达到 20/20；安全边界扩展再次 RED 为 20/22，修正凭据 percent 编码与编码控制字符校验后 GREEN 为 22/22（1 file，966ms）。覆盖合法 Neon/CHECK、凭据脱敏、损坏 URL 与 percent 编码、主机边界、expected mismatch、跨平台 npm 命令选择，以及确认模式 `shell: false` spawn 合同；没有执行真实 spawn、连接或迁移。
- 最终复核再次取得 focused tests 22/22（1 file，1.05s）、`tsc --noEmit` 0 错误、完整 ESLint 0 错误及 `git diff --check` 0 错误。另用仅含虚构 Neon 目标的临时、gitignored env 文件执行真实 CLI `--check`，其只显示 host/database 并以 0 退出；临时文件随后删除，未进入确认模式、未启动 npm 子进程、未连接数据库。
- Task 6 第三次质量复核发现 Windows 命令提示符示例会在变量展开阶段重新解释特殊字符，因此先前“安全保留为一个参数”的跨 shell 声明不成立。runbook 已完全删除该变体及相关变量展开/清理命令；Windows 发布者现在必须使用 PowerShell，POSIX 发布者继续使用带引号的变量形式。对含空白、引号、控制字符或 shell 元字符的 dashboard identifier，发布者必须停止并取得经复核的 Neon 名称，不得自行设计转义。

### Task 7 纯合成测试数据工具

- `5978eab`：新增受保护的免费测试 seed。它只创建 `alice@datecn.test` 与 `liam@datecn.test`，使用 Better Auth 原生密码哈希，并以单事务、advisory lock、INSERT-only 和精确回读实现幂等及冲突关闭；数据包括完整资料、兴趣、合成照片占位记录、免费测试权益、双向喜欢、匹配、活跃会话及双方初始消息。
- 凭据由安全随机数生成，不写终端，只在首次运行时原子写入 gitignored `.artifacts/free-test-credentials.json`；已有文件会被验证和复用，冲突、符号链接或不安全路径会停止。两张照片当前仅为数据库占位记录，不包含 Blob 对象；真实合成图片上传仍属于临时网址 smoke。
- 初始实现通过 seed 与迁移相关测试 55/55、TypeScript、全量 ESLint 和 diff-check。独立规格复核随后发现 seed 只限制为 TLS Neon、没有独立确认具体 Neon 目标，因此未放行。
- 后续修复复用迁移门禁的参数解析与精确目标比较：CLI 必须接收人工从 Neon 页面复制的 `--expected-host` 和 `--expected-database`。缺失、重复、未知、大小写/尾点不一致或目标不匹配时，会在凭据 I/O 和数据库工厂调用前以固定脱敏错误停止；不能从 `DATABASE_URL` 自行推导预期值。相关 seed 与迁移测试目前为 64/64，尚待同一规格复核员复验。
- 独立质量复核进一步发现 PostgreSQL URL 查询参数及 ambient `PG*` 变量可覆盖实际主机、身份、端口或 `search_path`，也发现 `.artifacts` 目录链接可把凭据写到工作区外。修复后的共享门禁只允许唯一安全 `sslmode` 与可选精确 `channel_binding=require`，拒绝其他查询参数及非空 `PG*`；凭据写入前必须确认直接父目录是普通目录而非 symlink/junction，CLI 默认路径固定到应用根目录下的 `.artifacts/free-test-credentials.json`。runbook 同时改为连续运行两次 seed 后再清理目标变量，并说明 Windows 需独立验证受限 ACL。
- 真实 seed 数据库客户端增加 10 秒连接上限；事务内设置 10 秒锁等待、30 秒语句和空闲事务上限，避免网络或遗留锁让发布步骤无限等待。PowerShell/POSIX 示例只在第一次 seed 成功后运行第二次，并在成功或失败后清理临时目标变量。
- 规格复验又覆盖“链接父目录中已经存在合法凭据”的路径：父目录普通目录检查现已提前到任何凭据读取之前，并在读取返回、临时写入和最终硬链接前重复验证；外部已有文件保持不变。seed 与迁移专项回归增至 85/85。
- 最终攻击复验补充了 node-postgres 解析差异：`PG*` 名称现在按大小写不敏感方式拒绝，authority 端口只允许省略或精确 `5432`，数据库路径必须恰好一个斜杠且名称限于字母、数字、下划线和连字符，避免双斜杠及 `%3F` 等保留字符编码被门禁与运行时解释成不同目标。POSIX 示例也改为在 `set -e` 下仍能统一清理并传播失败状态。
- Task 7 最终规格复核与质量复核均为 PASS / `Ready: Yes`。最终 focused seed+migration 为 98/98，TypeScript、全量 ESLint、diff-check 通过，worktree clean；未连接数据库、未执行真实 seed、迁移、Vercel 或 DNS。恢复点依次包含 `5978eab`（初始 seed）、`1efcfc6`（精确目标）、`72a6576`（query/PG 与目录防护）、`2789648`（已有凭据 junction 防护）、`34e2e52`（node-postgres 解析一致性）。

## 7. 归档结论与恢复起点

- 归档结论：15 阶段的本地实现和本地验收已完成。
- 当前边界：尚未进行生产部署；免费公网测试也因 Vercel Hobby CPU 配额超限而尚未开始。生产发布仍需完成外部数据库恢复、真实供应商和完整生产门禁。
- 继续工作时以 Task 7 的受保护纯合成 seed 及精确 Neon 目标确认修复为恢复起点，不需要重做前 15 阶段、免费 Vercel 兼容 Task 1—5 或 Task 6 文档门禁。
- 下一次先重新读取 Vercel 免费额度；额度未清零则停止。额度清零后按免费测试部署 runbook 从独立资源 provisioning 开始，临时 URL 验收通过前不得修改 DNS。

## 8. 免费公网测试部署完成（2026-08-26，取代上方旧外部状态）

### 已完成的外部配置

- 私有仓库：`lilianfu701-pixel/GPTlucktime`；部署分支：`codex/global-dating-platform`；主分支未修改。
- Vercel Hobby 项目：`datecn`。最终生产部署 `dpl_6RH7Hzrp3d4dSrLvMNRXAWPemDp9` 状态为 `READY`；稳定临时验收地址为 `https://datecn-lilianfu701-pixels-projects.vercel.app`。
- 免费资源：Neon 数据库 `datecn-db`、Upstash Redis `datecn-cache`、私有 Vercel Blob `datecn-media`，均连接 Production 与 Preview；未填写银行卡、未开通付费计划。
- 免费测试环境明确禁止真实 Stripe、邮件、短信和实名认证配置；只使用虚构 `@datecn.test` 会员和合成数据。
- 数据库 41 个迁移全部执行并核验；迁移记录数为 41。
- 受保护 seed 连续执行两次并通过幂等核验：2 个用户、2 个账户、2 份资料、1 个匹配、1 个会话、2 条消息。随机测试密码仅保存在 gitignored 的 `.artifacts/free-test-credentials.json`，未上传 Vercel、未写入日志或终端。
- 部署分支新增 `1aad823`（Vercel 根目录与敏感文件排除规则），Git 提交身份改为 GitHub 官方 noreply 地址，从而解除 Vercel 的协作者识别拦截。

### 实际公网验收

- 中文首页、登录、演示发现、演示匹配、演示个人中心、演示会员、演示消息和演示个人资料均实际打开，无 404 或服务器错误。
- Alice 虚拟会员真实登录成功；真实发现页显示 Liam；真实消息页显示 Liam 和预置双方消息；真实会员设置显示免费测试权益；真实资料页回读 Alice 与 San Francisco。
- 本地正式构建在纯占位安全环境下通过；Vercel 云端生产构建完成全部 23 个静态页面生成及所有动态/API 路由编译。
- 移动端/成员壳/演示交互聚焦回归为 3 个测试文件、14 项全部通过。此前归档所述完整本地回归仍保持有效。

### 域名切换完成

- `datecn.org` 与 `www.datecn.org` 已加入 Vercel Production；Vercel 配置为根域名以 308 跳转到 `www.datecn.org`。
- `APP_URL=https://www.datecn.org`、`BETTER_AUTH_URL=https://www.datecn.org/api/auth` 已写入 Production 与 Preview，并完成最终 READY 部署。
- 用户在看到精确旧→新差异后明确回复“确认修改DNS”。Cloudflare 两条旧 A 记录已替换为：`@ CNAME 67f9bcd0961808c5.vercel-dns-017.com.`（仅 DNS）、`www CNAME 67f9bcd0961808c5.vercel-dns-017.com.`（仅 DNS）。
- Vercel 对 `datecn.org` 与 `www.datecn.org` 均显示 `Valid Configuration`；`www` 连接 Production，根域名 308 跳转到 `www`。
- 最终公网实测：`https://www.datecn.org/zh` HTTPS 首页正常；`https://datecn.org/zh` 最终到达 `https://www.datecn.org/zh`；Alice 真实登录成功；真实发现页显示 Liam；消息页显示 Liam 与预置对话；会员中心和个人资料正常，无服务器错误。
