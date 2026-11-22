# 一笔一画书法课时系统

家长端为 `/`，管理员端为 `/admin`。原页面和课时操作由 Cloudflare Worker 提供，学员档案、课时及签到记录存入 D1。正式环境只录入经核对的实际记录。

## 本地运行

需要 Node.js 22.13 或更新版本。

```sh
npm ci
npm test
npm run test:worker
npm run check:bundle
```

本地预览可运行 `npx wrangler d1 migrations apply DB --local`、`npx wrangler d1 migrations apply BACKUPS --local` 和 `npm run dev`。测试会建立临时 D1 数据库并使用合成记录。

## Cloudflare 部署

仓库中的 `wrangler.jsonc` 默认指向本地示例数据库，公开地址和预览均关闭。创建测试环境与生产环境时，分别使用独立的 Worker、业务 D1 和备份 D1。

1. 在 Cloudflare 的 **Workers & Pages** 中连接本仓库。先部署测试 Worker。通过 Git 集成部署时，将下方配置生成脚本设为构建命令 `node scripts/configure-cloudflare.mjs`，将部署命令设为 `npx wrangler deploy --config wrangler.local.jsonc`。构建环境使用 Node.js 22.13 或更新版本。
2. 在 **Storage & Databases → D1 SQL Database** 创建业务数据库和备份数据库。业务库按编号应用 `drizzle/0000` 至 `drizzle/0002`，备份库应用 `backup-migrations/0001`。可在各自 D1 控制台执行对应 SQL 文件全文，每个文件执行一次。具备 D1 权限的终端也可使用 `npx wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc` 和对应的 `BACKUPS` 命令。选择其中一种迁移方式。
3. 在 Worker 的 **Build → Build variables** 中设置下表中的构建变量。环境 ID 使用 D1 控制台的 UUID，测试和正式各自填写。

| 构建变量 | 内容 |
| --- | --- |
| `YB_WORKER_NAME` | Cloudflare Worker 名称 |
| `YB_DB_NAME` | 业务 D1 名称 |
| `YB_DB_ID` | 业务 D1 UUID |
| `YB_BACKUP_DB_NAME` | 备份 D1 名称 |
| `YB_BACKUP_DB_ID` | 备份 D1 UUID |
| `YB_ALLOW_WORKERS_DEV` | 测试设为 `true`，正式自定义域名生效后设为 `false` |

4. 部署后在 Worker 的 **Settings → Variables and Secrets** 设置两项 **Secret**。为 `ADMIN_SETUP_KEY` 使用至少 32 个随机字符，为 `BACKUP_KEY` 使用 64 个随机十六进制字符（32 字节，用于 AES-256-GCM）。本地终端可用 `openssl rand -hex 32` 分别生成两次。把备份密钥保存在独立的密码管理器里。保留原密钥才能下载用它加密的快照。
5. 在测试 Worker 的 `/admin` 输入初始化密钥，设置账号和密码。生产 Worker 重复独立设置。初始化成功后从该 Worker 删除 `ADMIN_SETUP_KEY`。登录会话保存在服务端，修改密码会撤销旧会话。
6. 对测试 Worker 验证家长查询、扣课、撤销和备份，再配置正式域名。Worker Custom Domain 要求域名位于有效的 Cloudflare DNS 区域，Cloudflare 会为自定义域名生成 DNS 记录和证书。如区还由阿里云 NS 管理，先核对并迁移已有记录，再在阿里云域名控制台按 Cloudflare 指定值切换 NS。测试 Worker 保持使用临时地址。
7. 管理员在学员档案点击「家长查询码」，将查询码私发给该学员家长。查询需要姓名和码，更新查询码会使旧码失效。使用中国大陆移动网络，把正式网址发到微信聊天，在安卓和 iPhone 的微信内分别点击并验证：能直接打开、没有安全拦截或外跳、能查到测试课时、管理员记课后重新查询显示新余额和日期。两端均通过后再分享给实际家长。

## 备份和恢复

生成的生产配置每日北京时间 03:00 调度一次加密备份，单独写入备份 D1，保留 14 份日快照。Worker 和两套 D1 可使用 Free 计划，按实际用量和账户配置核实额度。备份库与业务库隔离，仍位于同一 Cloudflare 账户。

管理员可在「导出备份」下载当日业务数据，也可以在「备份与恢复」下载自动快照。下载文件内含学员资料和查询码。业务快照保留档案、余额、签到及撤销记录、课时审计，不含管理员密码或会话。网页快照上限为 1.25 MB。用独立加密存储留一份手动备份，可以应对整个云账户不可用的情况。

恢复先创建空业务 D1 并应用迁移，再在专用 Worker 完成管理员初始化，登录后从「备份与恢复」选择文件。已有业务数据的数据库会拒绝恢复。核对学员数量、余额、签到日期及撤销记录后，再切换生产绑定。此流程不改动旧数据库。
