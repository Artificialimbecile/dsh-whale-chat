# HTTP 接口 / Host API

宿主侧在 DSH Web server 上注册一条 prefix 路由：`/dsh-whale-chat`。
所有 `/api/*` 请求都会先过 DSH 的请求信任栅栏（`connection.requestRejection`，不可用时 fail-closed 503）；
`/assets/*` 与 `/selfcheck` 不敏感，可匿名访问。

响应统一为 JSON：`Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`。
错误统一为 `{ "ok": false, "error": "中文原因" }`。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/settings` | `{ ok, config, runtime, paths }` |
| POST | `/api/settings` | body 为 `{ config }` 或裸配置（支持局部深合并）；成功返回 `{ ok, config, runtime, warnings? }`，非法值 400 |
| GET | `/api/status` | `{ ok, runtime }`，轻量轮询用 |
| GET | `/api/history?limit=50` | `{ ok, messages }`，时间正序；聊天记录与主动消息（上网带回/碎碎念/报错）合并，主动消息带 `kind: "roam"\|"whisper"\|"error"`、`id: "p<数字>"`、`source: { name, url }` |
| POST | `/api/history/clear` | `{ ok, cleared, clearedProactive }`（同时清空 `memory.json` 与主动消息队列） |
| POST | `/api/chat` | body `{ text }`（1–8000 字）→ `{ ok, reply: { role, text, ts }, model, memoryCount }`；失败 `{ ok:false, error, reason }` |
| GET | `/api/messages?afterId=0&limit=20` | `{ ok, items, cursor, unreadCount }`，`id > afterId` 升序 |
| POST | `/api/messages/read` | body `{ id }` → `{ ok, unreadCount }`，标记 ≤ id 的主动消息已读 |
| POST | `/api/roam` | 立即上网一次（忽略安静时段与每日上限，最长等 60s）；成功 `{ ok, item, source, text }`，失败 `{ ok:false, error, reason }`，已在跑 `{ ok:false, skipped:"running" }` |
| POST | `/api/whisper` | 立即生成一句碎碎念（忽略「主动碎碎念」开关，设置页按钮用） |
| POST | `/api/selftest/chat` | body `{ text? }`，自检用一次性对话 |
| GET | `/assets/*` | 静态素材（webm / ttf / png），带路径穿越与扩展名白名单防护 |
| GET | `/selfcheck` | 自检页（纯 HTML + 内联 JS） |

## runtime 快照

```jsonc
{
  "version": "0.1.4",
  "model": { "provider": "deepseek-account", "model": "deepseek-flash" }, // 当前对话模型，可能为 null
  "chatModel": { "provider": "...", "model": "..." },                     // 实际生效的对话模型
  "memoryCount": 12,
  "unread": 1,
  "roam": {
    "enabled": true, "running": false, "todayCount": 2, "maxPerDay": 6,
    "lastAt": "2026-10-28T21:00:00+08:00", "nextAt": "2026-10-28T22:20:00+08:00",
    "lastSource": "V2EX 热帖", "lastError": null
  },
  "dataDir": "C:\\Users\\<你>\\.dsh\\dsh-whale-chat"
}
```

## 失败 reason

`/api/chat` 与 `/api/whisper` 的 `reason` 取值：
`no-model`（当前对话未配置模型）、`llm-unavailable`、`timeout`、`empty`（模型无正文）、`generate-error`、`bad-input`。

`/api/roam` 失败时 `reason` 为 `roam-failed`，`error` 是可直接展示给用户的中文原因
（例如「抓取被拒绝：目标是内网地址（…；如果你在用代理/虚拟网卡，可在设置里打开「允许代理 fake-IP」）」）。

## 素材路由

`GET /dsh-whale-chat/assets/<相对路径>`，例如：

```
/dsh-whale-chat/assets/webm/%E5%BE%85%E6%9C%BA%E5%91%BC%E5%90%B8%E4%BC%91%E9%97%B2.webm
/dsh-whale-chat/assets/font/candy.ttf
/dsh-whale-chat/assets/icon.png
```

只允许 `webm / ttf / png / json` 扩展名，且解析后的真实路径必须位于包内 `assets/`；路径穿越返回 400/404。
