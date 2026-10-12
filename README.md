# 校友通讯录

一套可以单独部署的校友通讯录。仓库里只有程序和虚构样例，不包含任何组织的名称、名单或题库。每个组织自己准备数据库、域名、名单和准入题库。

本地开发用 JSON 文件，不需要腾讯云账号。上线时改用部署方自己的腾讯云 CloudBase。账号、密码哈希、题库、校友基线、注册资料和个人经历都写在那一个私有数据库里。

## 你要自己接上的四样东西

1. **数据库**：本地用 JSON；上线用自己的 CloudBase 环境。
2. **域名**：在云托管控制台绑定，程序里没有站点地址。
3. **三份私有数据**：校友名单、已有成员账号、至少 3 道启用的准入题。待核对名单可以不准备。
4. **密钥**：会话签名密钥。启用云备份时再加一把备份密钥。管理员密码单独设置。

下面每一项都写明变量名、默认值和何时必填。可复制的变量模板在 [.env.example](./.env.example)。控制台里的点击顺序、备份恢复和上线检查见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 域名

程序只使用相对路径，不读取域名，也不生成带域名的链接。

在 CloudBase 云托管把自定义域名和 HTTPS 绑到这个服务。中国大陆域名需要先完成 ICP 备案。健康检查地址是 `/api/health`，管理后台是 `/admin`。容器监听 `PORT`，默认 `3000`。

云托管放在平台的反向代理后面，把 `TRUST_PROXY` 设为 `1`，答题锁定才会使用真实来源 IP。这只在代理会正确覆盖 `X-Forwarded-For` 时使用。

## 数据库

用 `ALUMNI_STORAGE_DRIVER` 选择存储。只接受 `json` 和 `cloudbase`。

| 取值 | 场合 | 数据放在 |
| --- | --- | --- |
| `json` | 本地开发，也是默认值 | `ALUMNI_STATE_DIR` 目录，默认 `data/runtime/` |
| `cloudbase` | 上线 | 部署方自己的 CloudBase 文档数据库 |

### 上线时的环境变量

运行中的网站读这些环境变量。`cloudbaserc.json` 只给 CloudBase 命令行和「从源代码部署」用，网站进程不读它。两处的环境 ID、服务名要填成同一套。

| 变量 | 何时必填 | 默认 | 填什么 |
| --- | --- | --- | --- |
| `ALUMNI_STORAGE_DRIVER` | 上线 | `json` | `cloudbase` |
| `CLOUDBASE_ENV_ID` | `cloudbase` | 无 | 存放数据的环境 ID。云托管所在环境和数据库所在环境可以不同，这里填数据库那个 |
| `CLOUDBASE_APIKEY` | 在自己电脑上迁移或建管理员时 | 无 | 该数据库环境的服务端 API Key。也可以改用一对临时密钥：`TENCENTCLOUD_SECRETID` 和 `TENCENTCLOUD_SECRETKEY`。服务已经跑在 CloudBase 上时，可以使用平台注入的运行时身份 |
| `CLOUDBASE_REGION` | 否 | `ap-shanghai` | 数据库环境所在地域 |
| `CLOUDBASE_STATE_COLLECTION` | 否 | `alumni_runtime` | 文档数据库集合名。以字母开头，后面只含字母、数字、下划线，总长不超过 32。集合要先建好，安全规则设为客户端不可读、不可写 |
| `ALUMNI_SESSION_SECRET` | `cloudbase` | 本地 JSON 会在数据目录生成 `session.key` | 至少 32 字节的随机字符串。每次部署使用同一把，换一把会使已登录成员全部掉线 |
| `ALUMNI_BACKUP_ENABLED` | 否 | 关闭 | 设为 `1` 后，每次写入和每次启动都生成一份新的加密云备份 |
| `ALUMNI_BACKUP_KEY` | 启用备份时 | 无 | 64 位十六进制字符，对应 32 字节。和会话密钥分开生成，另存一份私有恢复文件 |
| `ALUMNI_BACKUP_PREFIX` | 否 | `alumni-backups` | 云存储里的备份目录前缀 |
| `TRUST_PROXY` | 云托管上建议 | `0` | 云托管设为 `1` |
| `PORT` | 否 | `3000` | 容器监听端口 |

`cloudbaserc.json` 里现在是占位符：

```json
{
  "envId": "YOUR_CLOUDBASE_ENV_ID",
  "cloudrun": { "name": "alumni-directory" }
}
```

`envId` 与 `CLOUDBASE_ENV_ID` 填同一个值。`cloudrun.name` 换成自己的云托管服务名。

同一个集合里有两份文档：

- `primary`：账号、密码哈希、题库、校友基线、个人资料、经历、注册和锁定记录
- `analytics`：访问统计

云托管的最小实例数和最大实例数都设为 1。账号和资料写在同一份文档里，两个实例同时写会互相覆盖。一两百人按这个配置运行。环境需要开启「超限按量」，否则云托管会被停掉。

CloudBase 里还没有校友基线时，网站拒绝启动，并提示先运行 `npm run migrate-roster`。先在自己的电脑上完成迁移，再发布容器。

API Key、会话密钥、备份密钥和管理员密码只放环境变量或私有文件，不要写进 Git，也不要打进镜像。

## 私有数据文件

这些文件放在 `data/runtime/`。该目录已被 Git 忽略，Dockerfile 也不会把它复制进镜像。格式照 `data/*.example.json`。想换位置时设置右边的环境变量。

| 默认路径 | 环境变量 | 作用 |
| --- | --- | --- |
| `data/runtime/alumni-import.json` | `ALUMNI_ROSTER_PATH` | 校友基线 |
| `data/runtime/account-seed.json` | `ALUMNI_ACCOUNT_SEED_PATH` | 已有成员的姓名和登录账号 |
| `data/runtime/question-seed.json` | `ALUMNI_QUESTION_SEED_PATH` | 注册时要回答的题 |
| `data/runtime/pending-account-review.json` | `ALUMNI_ROSTER_REVIEW_PATH` | 可选。还没对上账号、需要人工核对的人 |

JSON 模式还可以用 `ALUMNI_STATE_DIR` 改掉整个数据目录，默认是 `data/runtime/`。这里面还有运行后生成的 `auth-state.json` 和 `session.key`，需要备份。

### 校友基线

`records` 是数组，也可以让整个文件就是这个数组。每条记录必须有 `name`。其余字段可以空着：

`edu` 院系，`cohort` 届别原文，`cohortYear` 入学年份，`status` 当前状态，`industry` 行业，`org` 公司或机构，`doing` 在做的事，`city` 城市原文，`cityNorm` 用于筛选的城市，`willingContact` 是否愿意被联系，`contact` 联系方式，`offer` 可提供，`want` 希望获得，`hiring` 合作需求，`message` 寄语。

`contact` 会保存，普通检索不返回。

已有 Excel 时，第一行是表头，从第二行起读取，列的位置是固定的：B 姓名，C 院系，D 届别，E 状态，F 行业，G 机构，H 在做的事，I 城市，J 可提供，K 希望获得，L 合作需求，M 寄语，N 是否愿意被联系，O 联系方式。A 列不读。

```bash
node import-xlsx.js "/绝对路径/校友表.xlsx"
```

第二个参数可以指定输出路径。不写则写入 `data/runtime/alumni-import.json`，或 `ALUMNI_ROSTER_PATH` 指向的文件。脚本会补上 `cohortYear`、`cityNorm` 和姓名拼音。

### 账号种子

只放姓名和账号，不放密码：

```json
{
  "accounts": [
    { "displayName": "张三", "username": "zhangsan" }
  ]
}
```

导入时初始密码等于 `username`。成员登录后应马上修改。同一个 `username` 只会导入一次；之后再改这个文件，不会重置已经存在的密码。

### 准入题库

仓库里没有题目，也没有标准答案。题干、选项、哪一项算答对，都由部署方自己写。程序不预设任何题目。

有两种写法，内容都来自部署方：

- 在管理后台「题库管理」里逐题填写；
- 或把私有文件放到 `data/runtime/question-seed.json`。`data/question-seed.example.json` 里的 `questions` 是空数组，只说明文件形状。

启用中的题目少于 3 道时，注册页提示题库维护中，不会用别的题目顶上。每题自己写 2 到 6 个选项。文件形状如下，`questions` 里放部署方自己的题：

| 字段 | 谁来填 |
| --- | --- |
| `id` | 出题人编的编号，不能空。同一个编号只导入一次 |
| `prompt` | 题干 |
| `options` | 2 到 6 个选项 |
| `correctIndex` | 正确答案在 `options` 里的位置，从 0 开始 |
| `active` | 是否启用。不写则视为启用 |
| `notes` | 可选。只给管理员看 |

```json
{ "questions": [] }
```

在管理后台改过的题目，重启不会被这份文件覆盖。网页答题不下发正确答案。

### 待核对名单

可以不提供。提供时写成：

```json
{
  "pending": [
    {
      "row": 1,
      "displayName": "示例成员",
      "username": "examplemember",
      "reasons": ["重名，待人工确认"]
    }
  ]
}
```

## 迁移和管理员

在放着上述私有文件的电脑上执行。`--dry-run` 只打印条数、含联系方式的条数和 SHA-256 摘要，不写数据库，也不打印姓名。

```bash
ALUMNI_STORAGE_DRIVER=cloudbase \
CLOUDBASE_ENV_ID=你的环境ID \
CLOUDBASE_APIKEY=你的服务端APIKey \
npm run migrate-roster -- --dry-run
```

摘要核对通过后去掉 `--dry-run`。目标里已经有一份不同的校友基线时，脚本拒绝覆盖。确认要整份替换时才加 `--replace`。

然后创建管理员。密码至少 12 位。脚本只打印账号名，不打印密码。

```bash
ALUMNI_ADMIN_USERNAME=admin \
ALUMNI_ADMIN_NAME="管理员" \
ALUMNI_ADMIN_PASSWORD="至少12位" \
npm run create-admin
```

账号已经存在时会失败，需要换一个 `ALUMNI_ADMIN_USERNAME`。

服务若暂时还没有数据库，可以在云托管环境变量里设置 `ALUMNI_ADMIN_BOOTSTRAP_PASSWORD`（至少 12 位）和 `ALUMNI_ADMIN_USERNAME`。服务只在找不到这个管理员时创建一次，不会覆盖后来改过的密码。这种方式的数据不一定跨实例保留，数据库就绪后应改用上面的迁移。

## 本地运行

```bash
npm ci
npm test
npm start
```

打开 <http://localhost:3000>。还没有 `data/runtime/alumni-import.json` 时，JSON 模式加载 `data/alumni.example.json`，里面只有一条虚构成员。

## 成员能看到哪些栏

检索和展示由 [config.js](./config.js) 的 `publicFields` 决定。想少公开一栏，从这份列表里去掉。`contact` 不在列表中，普通检索接口不返回联系方式；本人资料和管理员后台仍可查看。

## 不要放进仓库的内容

`data/runtime/`、真实名单、账号种子、题库、待核对名单、`.env`、CloudBase API Key、`ALUMNI_SESSION_SECRET`、`ALUMNI_BACKUP_KEY`、管理员密码、数据库备份、原始 Excel。

## 资料周年

账号种子导入和自己注册，都按当时的年月作为资料起算月。满一年后，每个周年的前 5 次成功登录会提醒核对资料。页面标题、logo 和帮助文案都是通用的，组织名称写在你自己的名单和群公告里。

群公告模板见 [docs/微信群公告.md](./docs/微信群公告.md)，把 `https://你的域名/` 换成自己的地址。
