# 本地开发环境

## 1. 前置条件

- Node.js >= 22.13.0
- PostgreSQL 17
- Redis（任务 4 起需要，尚未接入）

本项目的开发机为 Windows 且不具备可用的虚拟化能力（`VirtualizationFirmwareEnabled` 为 false），
因此不使用 Docker，PostgreSQL 以原生 Windows 服务方式安装。

## 2. 安装 PostgreSQL 17

```powershell
winget install --id PostgreSQL.PostgreSQL.17 --silent `
  --accept-package-agreements --accept-source-agreements `
  --override "--mode unattended --unattendedmodeui none --superpassword <你的密码> --serverport 5432 --enable-components server,commandlinetools"
```

安装后确认服务：

```powershell
Get-Service postgresql-x64-17
```

## 3. 创建角色与数据库

开发库和测试库必须分开。测试会建表、清表，绝不能指向开发库。

```sql
CREATE ROLE memorial LOGIN PASSWORD '<本地开发密码>';
CREATE DATABASE memorial_dev  OWNER memorial;
CREATE DATABASE memorial_test OWNER memorial;
```

## 4. 环境文件

两个文件都已被 `.gitignore` 忽略，不要提交。字段清单见 `.env.example`。

| 文件 | 用途 | DATABASE_URL 指向 |
|---|---|---|
| `.env.local` | `npm run dev` | `memorial_dev` |
| `.env.test` | `npm test` 的集成测试 | `memorial_test` |

`vitest.config.ts` 通过 Vite 的 `loadEnv("test", ...)` 读取 `.env.test`，
集成测试自身还会断言 `DATABASE_URL` 含有 `_test`，避免误连开发库。

## 5. 迁移

drizzle-kit 作为 CLI 运行，直接读进程里的 `DATABASE_URL`，不经过 `lib/env.ts`。
所以要显式指定目标库：

```powershell
# 测试库
$env:DATABASE_URL = ((Get-Content .env.test | Select-String "^DATABASE_URL=") -replace "^DATABASE_URL=","")
npm run db:migrate

# 开发库
$env:DATABASE_URL = ((Get-Content .env.local | Select-String "^DATABASE_URL=") -replace "^DATABASE_URL=","")
npm run db:migrate
```

修改 schema 后：

```powershell
npm run db:generate   # 生成迁移文件，需提交
npm run db:migrate    # 应用到目标库
```

迁移文件是仓库的一部分，必须提交。不要手工改已应用过的迁移，用新的向前迁移修正。

## 6. 常用命令

```bash
npm run dev
```

```bash
npm test
```

```bash
npx vitest run --project unit
```

```bash
npx vitest run --project integration
```

## 7. Windows 注意事项

用 PowerShell 写文件时不要用 `Set-Content -Encoding utf8`：
Windows PowerShell 5.1 会写入 BOM，Turbopack 解析 `package.json` 会直接失败。
需要写文件时用编辑器工具，或 `[System.IO.File]::WriteAllText()`。
