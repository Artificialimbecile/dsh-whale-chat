# 贡献指南 / Contributing

感谢你愿意一起把这只鲸鱼养大 🐳

## 硬约束

1. **零运行依赖、零构建**：`lib/` 下的代码必须能被 Node / 浏览器直接加载；不要引入 npm 依赖，不要加打包步骤。
2. **不要在宿主定时器/回调里抛异常**：DSH 规定同步回调抛错会终止整个宿主进程。所有定时器与异步任务必须自己 `try/catch` / `.catch()`。
3. **素材不要换**：`assets/webm/`、`assets/font/`、`icon.png` 来自 dsh-pet，按原项目许可**允许开源使用、禁止商用**，不要替换成别的来源，也不要把它们用于商业用途。见 [NOTICE.md](NOTICE.md)。

## 本地开发

```sh
git clone https://github.com/Artificialimbecile/dsh-whale-chat.git
cd dsh-whale-chat
node --test --test-isolation=none test/*.test.mjs   # 单测（99 个）
```

联调（推荐用独立开发 profile，不要污染你自己的主 profile）：

```powershell
# 1) 起一个开发用 DSH_HOME（放在仓库外或 .gitignore 覆盖的目录里）
$env:DSH_HOME = "C:\path\to\dsh-dev-home"
# 2) 从内置 web 模板建一个开发 profile
dsh --from-default-profile web --profile whaletest --dump-config
# 3) 把本仓库 link 进去
dsh plugin --profile whaletest add "link:C:\path\to\dsh-whale-chat"
# 4) 起开发实例（换一个端口，避免和正在用的 DSH 冲突）
dsh --profile whaletest --port 53999 --no-open
```

- 启动日志会打印 `?token=...` 的地址；用浏览器打开即可（同源 fetch 会自动带 auth cookie）。
- 自检页：`http://127.0.0.1:53999/dsh-whale-chat/selfcheck` —— 一次验证接口 / 素材 / 模型调用。
- 改客户端（`lib/client.js`）：刷新页面生效；改宿主（`lib/*.js`）：重启开发实例生效。

### 模拟器 / 无浏览器环境的验证

- 单测覆盖纯逻辑（配置合并与校验、提示词拼装、SSRF 判断、RSS/HTML/JSON 抽取、消息队列、路由分类）。
- 接口层可以直接用 curl / `Invoke-WebRequest` 带 auth cookie 调：`/dsh-whale-chat/api/status`、`/api/settings`、`/api/chat`、`/api/roam`。
- 视觉验证需要真实浏览器（headless Chrome 在本仓库贡献环境里通常可用）。

## 提交 PR

1. 一个 PR 只做一件事；改了行为就加/改单测。
2. `node --test --test-isolation=none test/*.test.mjs` 必须全绿。
3. `node --check lib/*.js` 必须通过。
4. 面向用户的文案用中文；错误信息要能指导用户（说清「为什么 + 怎么办」）。
5. 不要提交任何凭据、token、个人路径或 `.dshdev/` 里的东西。

## 发布

- npm 包名：`dsh-whale-chat`，`files` 白名单在 `package.json` 里（只发 `lib/`、`assets/`、清单与文档）。
- 版本遵循 semver；发布后到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 更新 `data/plugins/Artificialimbecile__dsh-whale-chat.yml`（dsh-market 会自动收录）。
