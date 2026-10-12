# 部署与交接说明

环境变量、数据文件和域名的约定写在 [README](./README.md)。本文是创建云资源和上线时的操作顺序。

## 只有域名、不买服务器

域名只是网址，本身不能运行登录接口或保存数据。这个项目不需要购买云服务器，推荐使用腾讯云 CloudBase：

- CloudBase Run 运行现有 Node.js 网站；本项目为避免冷启动，生产环境保持 1 个最小实例；
- CloudBase 文档数据库保存账号、密码哈希、题库、锁定记录、初始校友基线和新注册校友资料；
- 自定义域名和 HTTPS 由托管平台接入；
- 本地开发继续使用 JSON，不依赖腾讯云账号。

CloudBase 属于托管服务，基础套餐之外，云托管 CPU、内存和公网流量仍会按量计费，但不需要自己安装系统、维护服务器或购买固定配置的云主机。云托管要求环境开启“超限按量”，关闭后服务会被停止。正式绑定中国大陆域名时应提前完成实名认证和 ICP 备案。

## 本地 JSON 模式

```bash
ALUMNI_STORAGE_DRIVER=json
ALUMNI_STATE_DIR=/var/lib/alumni-directory
ALUMNI_SESSION_SECRET=至少32字节的随机字符串
TRUST_PROXY=1
PORT=3000
```

`TRUST_PROXY=1` 只应在可信反向代理正确覆盖 `X-Forwarded-For` 时使用，否则攻击者可能伪造 IP 来绕过答题锁定。

JSON 模式需要长期磁盘，必须备份：

```text
$ALUMNI_STATE_DIR/auth-state.json
$ALUMNI_STATE_DIR/session.key
```

`auth-state.json.bak` 只是上一版副本，不能替代异地备份。

真实名单先放入 Git 忽略的 `data/runtime/alumni-import.json`，再运行 `npm run migrate-roster` 写进本地状态。代码仓库只保留 `data/alumni.example.json` 虚构样例。

## CloudBase 模式

云托管环境和数据库环境可以是两个不同的环境。`CLOUDBASE_ENV_ID` 必须填写实际存放 `alumni_runtime` 的数据库环境 ID，不要默认填写 CloudRun 服务所在的环境；`CLOUDBASE_APIKEY` 使用该数据库环境创建的服务端 `api_key`。

### 1. 创建资源

1. 在腾讯云 CloudBase 控制台创建上海地区环境。
2. 在文档数据库中新建集合 `alumni_runtime`。
3. 给该集合设置安全规则：客户端 `read=false`、`write=false`。账号密码和题目答案只能由服务端或控制台访问。
4. 创建服务端 API Key，不要使用可放在浏览器里的 Publishable Key。
5. 开启环境的“超限按量”，否则 CloudBase Run 无法持续提供服务。
6. 当前版本把小规模运行时状态保存在同一个文档中，CloudBase Run 的最小实例数和最大实例数都设为 1：保持服务常驻，同时避免两个实例并发写入造成覆盖；150 人规模足够使用。

### 2. 配置环境变量

```bash
ALUMNI_STORAGE_DRIVER=cloudbase
CLOUDBASE_ENV_ID=你的环境ID
CLOUDBASE_REGION=ap-shanghai
CLOUDBASE_STATE_COLLECTION=alumni_runtime
CLOUDBASE_APIKEY=服务端APIKey
ALUMNI_SESSION_SECRET=至少32字节的固定随机字符串
ALUMNI_BACKUP_ENABLED=1
ALUMNI_BACKUP_KEY=独立生成的32字节随机密钥（64位十六进制，另存私有恢复文件）
ALUMNI_BACKUP_PREFIX=alumni-backups
TRUST_PROXY=1
PORT=3000
```

`CLOUDBASE_APIKEY`、`ALUMNI_SESSION_SECRET` 和管理员密码都不能提交 Git。CloudBase 模式强制要求固定的 `ALUMNI_SESSION_SECRET`，否则容器重启后所有登录状态会失效。

备份密钥同样只保存在服务端与独立私有恢复文件中。启用后，每次状态写入和每次部署启动都生成新的加密云存储文件，下载核对成功才确认保存；旧文件长期保留，程序不覆盖或清理。不能用容器本地文件代替持久备份。完整导出、草稿保护和恢复步骤见 [备份与恢复](./docs/备份与恢复.md)。

### 3. 迁移校友基线

把真实名单放到 Git 忽略的 `data/runtime/alumni-import.json`。账号种子、题库和待核对名单也只保存在 `data/runtime`；迁移脚本会在首次连接空数据库时一并初始化账号和题库，并同步待核对名单。先只做校验：

```bash
ALUMNI_STORAGE_DRIVER=cloudbase \
CLOUDBASE_ENV_ID=实际数据库环境ID \
CLOUDBASE_APIKEY=服务端APIKey \
npm run migrate-roster -- --dry-run
```

数字和摘要核对无误后，去掉 `--dry-run` 正式写入。脚本只打印总数、联系方式条数和 SHA-256 摘要，不打印姓名或联系方式；写入后会从 CloudBase 回读核对。目标中已有不同基线时默认拒绝覆盖，需要人工核对后显式加 `--replace`。

CloudBase 模式下，数据库没有校友基线时应用会拒绝启动。这样能防止遗漏迁移后上线一个空通讯录，也不需要把真实名单打进镜像。

### 4. 初始化管理员

在相同 CloudBase 环境变量下运行：

```bash
ALUMNI_ADMIN_USERNAME=admin \
ALUMNI_ADMIN_NAME="管理员" \
ALUMNI_ADMIN_PASSWORD="至少12位且不要使用姓名拼音" \
npm run create-admin
```

脚本会把管理员写进 CloudBase，不会把密码写进代码或日志。

如果数据库尚未启用、只能暂时使用 CloudRun 本地 JSON，可在服务环境变量中设置 `ALUMNI_ADMIN_BOOTSTRAP_PASSWORD`（至少 12 位）和 `ALUMNI_ADMIN_USERNAME=admin`。服务只会在找不到管理员账号时创建，不会覆盖已修改的密码；这种模式不能保证账号和资料跨实例持久化，应尽快启用 CloudBase 数据库并迁移。

### 5. 部署网站

仓库根目录已包含 `Dockerfile`，可按 CloudBase Run 的“从源代码部署”流程构建。服务监听 `PORT` 环境变量，健康检查地址为 `/api/health`。

每个组织使用自己的 CloudBase 环境和自定义域名。把 `cloudbaserc.json` 里的 `envId`、服务名，以及环境变量 `CLOUDBASE_ENV_ID` 换成自己的；域名和 HTTPS 在云托管控制台绑定，不要写进代码。更新代码时先在本地通过测试，再发布新版本，不要更换已经在用的数据库环境，也不要覆盖现有运行时状态。

单账号登录占用保存在同一份运行时状态中，因此生产服务必须保持 **最大实例数为 1**。使用初始密码的账号仍按先到先得拒绝第二次登录；改过密码的成员可以选择“退出旧设备并登录”，旧设备令牌随后失效。主动退出立即释放；页面在前台时每 60 秒续期，后台页面不续期，浏览器异常关闭或断网后约 5 分钟自动释放。管理员也可在“账号管理”中手动解除。数据库写入使用事务比较读取时的状态，发现其他进程已修改便拒绝旧状态覆盖；命令行迁移仍应在维护窗口进行，冲突时重新加载后重试。首次部署这项功能时，旧版登录令牌会失效，成员需重新登录。

## 首次上线检查

1. 确认私有的 `data/runtime/account-seed.json` 与待导入名单一致，并核对 `data/runtime/pending-account-review.json`。
2. 运行 `npm ci && npm test`。
3. 迁移校友基线并核对 CloudBase 回读的记录总数和摘要。
4. 创建管理员，并确认后台题库条数与 `data/runtime/question-seed.json` 一致。
5. 用测试姓名走完“站内资料 → 随机 3 题 → 自动开户”，再次尝试时确认题目会更换。
6. 在管理员后台“新用户申请与注册资料”中确认能看到完整资料、状态和开户记录，并测试 CSV 导出。
7. 确认新资料登录后可以被检索；联系方式、联系意愿和可联系状态不在普通检索接口中返回，机构、当前状态和经历只向已登录成员展示。
8. 连续答错 5 次，确认该姓名的自助注册锁定 1 小时，换网络后仍不可重试；再从后台提前解锁。
9. 通过 HTTPS 域名检查电脑和手机端。

不要把 `data/runtime`、`data/alumni.json`、`data/account-seed.json`、`data/question-seed.json`、`data/pending-account-review.json`、管理员密码、CloudBase API Key、原始表格导出或数据库备份提交到 GitHub。Dockerfile 只复制运行必需的代码、前端和虚构样例，不再复制整个仓库。

## 备份与恢复

JSON 模式按天备份运行目录。CloudBase 模式应在控制台开启数据库备份或定期导出 `alumni_runtime/primary` 和 `alumni_runtime/analytics` 两份文档，并把备份放到另一个存储位置。

恢复 CloudBase 时，先停止对外访问，再将已核验的账号资料 `state` 恢复到 `alumni_runtime/primary`，访问统计恢复到 `alumni_runtime/analytics`，然后重启服务。如果只更换 `ALUMNI_SESSION_SECRET`，用户需要重新登录，但密码和校友资料不会丢失。

## 更新代码

更新前先备份数据，然后运行：

```bash
git pull --ff-only
npm ci
npm test
```

测试通过后再构建新镜像。CloudBase 存储与代码目录分离，重新部署容器不会清空数据库。
