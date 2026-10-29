# dsh-whale-chat 🐳

[![npm](https://img.shields.io/npm/v/dsh-whale-chat)](https://www.npmjs.com/package/dsh-whale-chat)
[![license](https://img.shields.io/badge/code-MIT-blue)](https://github.com/Artificialimbecile/dsh-whale-chat/blob/main/LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-8a2be2)](https://github.com/topics/dsh-plugin)

> 一只会说话的透明鲸鱼桌宠，住在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web 界面右下角。
> **形象与动画沿用 [`dsh-pet`](https://github.com/PC2005-cloud/dsh-pet)（二次创作）**，设置页风格参考 [`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale)。
>
> A talking whale desktop pet for DeepSeek Harness: chat with it, give it a persona, and let it wander the web on its own to bring back things worth telling you. Art & animations are a derivative work based on [`dsh-pet`](https://github.com/PC2005-cloud/dsh-pet).

![桌宠与对话面板](https://raw.githubusercontent.com/Artificialimbecile/dsh-whale-chat/main/screenshots/chat-panel.png)

## 功能

| 功能 | 说明 |
|---|---|
| 🐳 透明桌宠 | 640×360 VP9-alpha `.webm` 动画：待机呼吸 / 随机小动作 / 点击回应 / 拖拽 / 思考 / 说话 / 出门溜达；可拖到四个角，位置自动保存 |
| 💬 主动聊天 | 双击宠物打开对话面板（她说话的气泡也可以点开），Enter 发送、Shift+Enter 换行；对话记忆持久化，重启不丢 |
| 🎭 可配置人设 | 名字 / 她怎么称呼你 / 她怎么自称 / 人设正文（≤20000 字）；与时间背景一起拼成 system 提示词 |
| 🌏 随机上网 | 按「间隔 × 随机抖动」自己出门，从来源清单随机挑站点抓取，让模型用人设口吻把见闻说给你听；支持每日上限、安静时段、失败降级 |
| ⚙️ 设置页 | DSH 设置 →「鲸聊」：人设、对话模型、上网偏好、来源清单、外观、状态与一键工具 |
| 🔒 安全 | 抓取带 SSRF 防护（只允许公网 http/https，DNS 解析后校验回环/私网/链路本地地址）、超时与体积上限；API 走 DSH 的请求信任栅栏 |
| 🧠 零额外依赖 | 纯 ESM + 浏览器原生，无 npm 运行依赖、无需构建 |

默认模型跟随当前对话（零配置）；也可以单独指定便宜的 provider/model 给对话与碎碎念。

## 安装

要求：**DSH 0.2.1 及以上的 Web 界面**（桌面版或 `dsh web` 均可），宿主 Node.js ≥ 22。

### 从 GitHub 安装

```sh
dsh plugin --profile desktop add github:Artificialimbecile/dsh-whale-chat
```

> 这条命令走 pnpm 的 git 解析（需要机器上有可用的 `git`）。如果报 `ERR_PNPM_GIT_RESOLVE_FAILED`，改用下面的 Release 预构建包：

```sh
dsh plugin --profile desktop add https://github.com/Artificialimbecile/dsh-whale-chat/releases/latest/download/dsh-whale-chat.tgz
```

### 从 npm 安装（推荐）

```sh
dsh plugin --profile desktop add dsh-whale-chat
```

npm 安装是预构建包，不需要 build 授权，也不依赖 `git`，最省事。

（不是 desktop profile 就把 `--profile` 换成你的 profile 名，例如 `web`。）

### 本地目录（开发 / 自用）

```sh
dsh plugin --profile desktop add "link:C:\path\to\dsh-whale-chat"
```

装完重启 DSH（或看「设置 → 插件」列表里出现 `dsh-whale-chat`）。之后：

- 右下角出现鲸鱼（设置 →「鲸聊」→ 外观，可改大小 / 角落 / 边距 / 关闭显示）；
- DSH 设置里多一行「**鲸聊**」；
- 数据目录：`<DSH_HOME>\dsh-whale-chat\`（默认 `C:\Users\<你>\.dsh\dsh-whale-chat\`）。

### 卸载

```sh
dsh plugin --profile desktop remove dsh-whale-chat
```

数据目录不会自动删除；彻底清理时手动删除 `<DSH_HOME>\dsh-whale-chat\`。

## 快速上手

1. **设置 → 鲸聊**：改名字 / 称呼，在「人设正文」写几行她的来历、语气、在意什么（不写也能用内置默认人设）。
2. 双击右下角鲸鱼打开对话面板，发一句「在吗」，看她的回复。
3. **上网逛逛**：确认开关与间隔；点「立即上网看看」立刻抽一个来源、抓取并让她说给你听。
4. 来源清单每行一个：`名称 | URL | 类型`，类型可写 `auto` / `json` / `rss` / `html`（留空按 auto）。想加自己的 RSS 或站点就加一行。

![设置 → 鲸聊](https://raw.githubusercontent.com/Artificialimbecile/dsh-whale-chat/main/screenshots/settings-persona.png)

## 配置

设置页写入 `<DSH_HOME>\dsh-whale-chat\config.json`（完整快照）。也可以直接编辑该文件，保存后刷新页面生效（上网调度参数改完立即重算下次时间）。

```jsonc
{
  "persona": {
    "name": "小鲸",              // 她的名字
    "ownerTitle": "主人",        // 她怎么称呼你
    "selfClaim": "我",           // 她怎么自称
    "text": ""                   // 人设正文；空 = 内置默认人设
  },
  "chat": {
    "memoryRounds": 5,           // 每次对话带多少轮历史
    "provider": "",              // 留空 = 跟随当前对话模型
    "model": "",
    "temperature": 1
  },
  "appearance": {
    "enabled": true,
    "size": 320,                 // 宠物宽度 px（160–640）
    "corner": "bottom-right",    // bottom-right / bottom-left / top-right / top-left
    "marginX": 24,
    "marginY": 96,
    "bubbleSeconds": 14,
    "fontFamily": "candy"        // candy（内置软糖体）| system
  },
  "roam": {
    "enabled": true,
    "intervalMin": 90,           // 基础间隔（实际 = 90 × 0.75~1.25 分钟随机）
    "maxPerDay": 6,
    "quiet": { "enabled": true, "start": "23:00", "end": "08:00" },
    "includeLink": true,
    "charLimit": 3000,
    "reportFailure": true,
    "allowFakeIp": true,         // 代理 fake-IP 兼容（见「常见问题」）
    "sources": [
      { "name": "V2EX 热帖", "url": "https://www.v2ex.com/api/topics/hot.json", "type": "json" }
    ]
  },
  "whisper": { "enabled": false, "intervalMin": 60, "quietSameAsRoam": true }
}
```

默认来源（7 个，全部实测可用）：B 站热门 / V2EX 热帖 / 知乎日报 / 少数派 / Solidot / IT 之家 / 中文维基随机。

### 数据文件

| 文件 | 说明 |
|---|---|
| `config.json` | 用户配置 |
| `memory.json` | 对话记忆（最多 1000 条，全量保存，按 `memoryRounds` 截取进上下文） |
| `messages.json` | 主动消息队列（上网见闻 / 碎碎念 / 失败提示） |
| `state.json` | 上网调度状态（今日次数、上次/下次时间、上次来源与错误） |

删除 `memory.json` 即清空对话记忆（设置页有「清空对话记忆」按钮）。

![上网来源与外观](https://raw.githubusercontent.com/Artificialimbecile/dsh-whale-chat/main/screenshots/settings-sources.png)

## 工作原理

- **宿主侧**（`lib/index.js` 等）：一条 `/dsh-whale-chat` prefix 路由提供接口与素材；30 秒 tick 的调度器按配置决定「现在该不该出门」；抓取网页 → 抽取标题/正文 → 用 `ctx.llm`（DSH 的模型统一抽象）转述成人设口吻的消息 → 入队。
- **浏览器侧**（`lib/client.js`）：通过 DSH 模块系统加载；`shell.overlay` 槽注册桌宠与对话面板，`settings.section` 槽注册设置页；每 12 秒增量拉取主动消息，弹气泡 + 播「出门溜达」动画。

接口契约见 [docs/API.md](https://github.com/Artificialimbecile/dsh-whale-chat/blob/main/docs/API.md)，架构与开发说明见 [docs/ARCHITECTURE.md](https://github.com/Artificialimbecile/dsh-whale-chat/blob/main/docs/ARCHITECTURE.md)。

## 常见问题

**「她老是说『那个地址我进不去』/ 日志写『抓取被拒绝：目标是内网地址』」**
多半是代理/加速器开了 **fake-IP**（Clash/Surge 默认把域名解析成 `198.18.x.x` 假地址）。本插件默认已打开「允许代理 fake-IP」只放行这一段，其它内网/回环地址仍然拒绝；如果手动关掉了，去「设置 → 鲸聊 → 上网逛逛」重新打开。

**「B 站热门偶尔抓不到内容」**
B 站 ranking 接口有风控（HTTP 200 + `code:-352`）。插件已用真实浏览器 UA 规避；如果哪天又抽风，她会跳过这次、下次换别的来源，也可以在来源清单里换成你常看站点的 RSS。

**「对话报『当前对话未配置模型』」**
说明 DSH 还没有默认模型。到 DSH 设置里选一个模型，或在「鲸聊 → 对话」里单独填服务商 + 模型（两个字段要么都填、要么都留空）。

**「想清空记忆 / 改配置后不生效」**
「清空对话记忆」按钮会清空 `memory.json`；改外观/人设在保存后立即生效，改上网参数会重算下次出门时间。

## 已知限制

- 桌宠是 **Web 界面 overlay**（与 dsh-pet 浏览器形态同款），不提供脱离浏览器的桌面透明窗模式。
- 没有拖拽甩抛物理，只有拖动摆放；动画链做了简化（待机 / 小动作 / 位移 / 点击回应 / 思考 / 说话 / 出门）。
- 网页抓取依赖宿主进程的网络环境；被墙/超时会降级为一句「没连上」的提示，不会伪造内容。
- 只支持 DSH `web` 客户端平台。

## 二次创作与素材来源（重要）

本项目是 **[dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的二次创作（derivative work）**，不是 dsh-pet 官方项目，也不代表原作者立场。

| 内容 | 来源 | 许可 |
|---|---|---|
| 动画素材 `assets/webm/*.webm`（35 段，原样拷贝、文件名未改） | [dsh-pet/assets/webm](https://github.com/PC2005-cloud/dsh-pet/tree/main/assets/webm) | 允许开源使用，**禁止商用**（见 [原项目「许可」节](https://github.com/PC2005-cloud/dsh-pet#-许可)） |
| 字体 `assets/font/candy.ttf`（上首软糖体） | dsh-pet `assets/fonts/` | 同上 |
| 图标 `icon.png` | dsh-pet `assets/logo.png` | 同上 |
| 桌宠形态与设置页信息架构 | dsh-pet / [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)（仅参考思路，代码为重新实现） | MIT |

- **代码**（`lib/`、`test/`、构建脚本之外的所有源码）以 **MIT** 许可发布，见 [LICENSE](https://github.com/Artificialimbecile/dsh-whale-chat/blob/main/LICENSE)。
- **素材**（动画 / 字体 / 图标）版权归 dsh-pet 原作者所有，按原项目 README 的素材许可：**允许开源使用、禁止商用**。如需商用，请直接联系 [dsh-pet 原作者](https://github.com/PC2005-cloud) 取得授权。
- 如果你是 dsh-pet 作者并认为本项目的复用方式不妥，请开 issue，我会调整或移除相关素材。

完整归属说明见 [NOTICE.md](https://github.com/Artificialimbecile/dsh-whale-chat/blob/main/NOTICE.md)。

## 开发

```sh
git clone https://github.com/Artificialimbecile/dsh-whale-chat.git
cd dsh-whale-chat
node --test --test-isolation=none test/*.test.mjs   # 99 个单测
```

本地联调：把仓库 `link:` 装进一个开发 profile，改完客户端代码刷新页面、改完宿主代码重启该 profile；`/dsh-whale-chat/selfcheck` 自检页能一次性验证接口与模型调用。细节见 [docs/ARCHITECTURE.md](https://github.com/Artificialimbecile/dsh-whale-chat/blob/main/docs/ARCHITECTURE.md)。

欢迎 issue / PR。提交前请跑一遍单测。

## 许可

- 代码：[MIT](https://github.com/Artificialimbecile/dsh-whale-chat/blob/main/LICENSE)
- 素材（来自 dsh-pet）：允许开源使用、禁止商用，详见 [NOTICE.md](https://github.com/Artificialimbecile/dsh-whale-chat/blob/main/NOTICE.md)
