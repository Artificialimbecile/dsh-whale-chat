/**
 * dsh-whale-chat（鲸聊）—— 浏览器侧单文件模块
 *
 * ============================================================================
 * 这个文件是什么
 * ============================================================================
 * 一个 classic script（不是 ESM）：由 DSH 的模块加载器在 Web GUI 里执行，
 * 通过 `window.__ModuleLoader__.load({ id, factory })` 注册。`factory(require)`
 * 里只能拿到宿主注入的白名单模块（这里只用 `react`）。
 *
 * 它向 DSH 注册两块界面：
 *   1. `shell.overlay`   —— 右下角透明鲸鱼桌宠（拖动 / 点击回应 / 气泡 / 对话面板）
 *   2. `settings.section` —— 设置里的「鲸聊」页（六组配置 + 状态与工具）
 *
 * ============================================================================
 * 为什么把东西都塞在一个文件里
 * ============================================================================
 * DSH 客户端插件按约定是单文件浏览器脚本，走 `dsh.client` 暴露、由启动图注入。
 * 拆文件会让宿主多一条静态路由与加载顺序问题；这个插件界面规模可控，单文件
 * 反而好审。所有 CSS 用 `<style data-plugin-css="dsh-whale-chat">` 只注入一次，
 * 卸载组件时不移除（DSH 里设置页与浮层可能交替挂载）。
 *
 * ============================================================================
 * 可靠性约定（为什么代码里到处是 try/catch）
 * ============================================================================
 * - DSH 规定同步回调抛错会终止整个宿主进程 → 定时器 / 事件回调 / 动画链
 *   一律自己吞异常，只 console.warn。
 * - 素材（webm / 字体 / icon）可能下载失败 → 视频 error 回退成 icon.png，
 *   icon 也失败再回退成 emoji；界面永远不白屏、不抛错。
 * - 接口可能 404 / 403 / 非 JSON / ok:false → 统一转成中文 Error，界面显示
 *   中文原因；轮询失败静默退避（12s → 24s → … → 最大 60s），连续 5 次失败
 *   在宠物旁点一个警示点。
 * - 组件卸载后不再 setState / 碰 DOM：所有异步路径都有 alive 守卫，所有
 *   定时器 / 监听器 / pointer capture 都在 useEffect 清理函数里收掉。
 *
 * 接口契约见仓库根目录 SPEC.md §4（路由）与 §6（本文件行为）。
 */
window.__ModuleLoader__.load({
  id: "dsh-whale-chat",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // 唯一允许的依赖：React 18（createElement，不用 JSX）。react-dom/client 不必要。
    const React = require("react");
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React;

    // =========================================================================
    // 常量
    // =========================================================================

    const API_BASE = "/dsh-whale-chat";
    const ASSET_BASE = "/dsh-whale-chat/assets";
    const ICON_URL = ASSET_BASE + "/icon.png";
    const WEBM_BASE = ASSET_BASE + "/webm/";
    const FONT_URL = ASSET_BASE + "/font/candy.ttf";
    const CSS_TAG = "dsh-whale-chat";

    /** 消息轮询基线：12s 一次；失败指数退避，封顶 60s。 */
    const POLL_BASE_MS = 12000;
    const POLL_MAX_MS = 60000;
    /** 设置（外观/名字）刷新间隔：设置页保存后也会广播自定义事件即时刷新。 */
    const SETTINGS_SYNC_MS = 60000;
    /** 拖动判定阈值（px）：小于它算单击，避免手抖把点击吃掉。 */
    const DRAG_THRESHOLD = 5;
    /** 单击延迟：给 dblclick 让路（双击要打开面板，不该先弹一句反应）。 */
    const CLICK_DELAY_MS = 240;
    /** 连续几次轮询失败后，在宠物旁显示警示点。 */
    const WARN_AFTER_FAILS = 5;

    /**
     * 动画池：与 `assets/manifest.json` 保持同一份（客户端硬编码，少一次启动请求）。
     * 素材文件名就是中文动画名，URL 里必须 encodeURIComponent。
     */
    const ANIM = {
      idle: ["待机呼吸休闲"],
      turn: ["东张西望"],
      drag: ["被鼠标拖拽悬空反馈"],
      clicks: [
        "点击回应-开心跃动",
        "点击回应-害羞惊讶",
        "点击回应-傲娇生气",
        "点击回应-挠痒咯咯笑",
        "点击回应-元气挥手",
      ],
      moves: ["螃蟹走路", "原地漂浮踏步", "原地左转奔跑"],
      actions: [
        "悠闲哼歌",
        "超大伸懒腰",
        "原地敲击桌面互动",
        "哈欠连天",
        "照镜子",
        "撸猫",
        "用鲸鱼尾巴拍打地面",
        "原地小憩沉眠",
        "被吓一跳",
        "轻快摇摆舞",
        "写代码",
        "蓝鲸现世",
        "鲸鱼吐泡泡特效",
        "吃Token",
        "玩水枪",
        "放烟花",
      ],
      thinking: ["工作状态-思考冒泡", "深度思考碎碎念"],
      busy: ["工作状态-忙碌点按"],
      talk: ["碎碎念-擦桌碎碎念", "碎碎念-发呆碎碎念", "碎碎念-对屏碎碎念"],
      roamWalk: ["螃蟹走路"],
      roamLook: ["东张西望"],
      happy: ["工作状态-雀跃庆祝"],
      sad: ["工作状态-垂头叹气冒汗"],
      sleep: ["原地小憩沉眠"],
    };

    /** idle 播完后的权重（对应 manifest.weights）：再待机 / 小动作 / 位移。 */
    const IDLE_WEIGHTS = { idle: 45, actions: 45, moves: 10 };

    /** 单击宠物的静态反应文案（6 条，客户端本地，不走模型）。 */
    const CLICK_LINES = [
      "嗯？叫我干嘛呀～",
      "我在呢，随时都在～",
      "别戳啦，好痒的！",
      "今天也要一起加油哦！",
      "咕噜咕噜……有点饿了。",
      "再戳我就要生气啦！",
    ];

    /** 字体栈：candy = 上首软糖体（插件自带 ttf），system = 系统字体。 */
    const FONT_STACKS = {
      candy:
        '"WhaleChatCandy","ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","PingFang SC","Microsoft YaHei",sans-serif',
      system: 'system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
    };

    const CORNERS = ["bottom-right", "bottom-left", "top-right", "top-left"];
    const CORNER_LABELS = {
      "bottom-right": "右下角",
      "bottom-left": "左下角",
      "top-right": "右上角",
      "top-left": "左上角",
    };
    const SOURCE_TYPES = ["auto", "json", "rss", "html"];
    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

    /**
     * 客户端兜底默认配置（与 SPEC §3 同构）。
     * 用途：宿主返回的 config 可能缺字段（旧版本/半安装），界面不能因此空白或
     * 把所有输入框渲染成空。真正的默认值仍以宿主 `config.js` 为准。
     */
    const DEFAULT_CONFIG = {
      version: 1,
      persona: { name: "小鲸", ownerTitle: "主人", selfClaim: "我", text: "" },
      chat: { memoryRounds: 5, provider: "", model: "", temperature: 1 },
      appearance: {
        enabled: true,
        size: 320,
        corner: "bottom-right",
        marginX: 24,
        marginY: 96,
        bubbleSeconds: 14,
        fontFamily: "candy",
        clickSound: false,
      },
      roam: {
        enabled: true,
        intervalMin: 90,
        maxPerDay: 6,
        quiet: { enabled: true, start: "23:00", end: "08:00" },
        includeLink: true,
        charLimit: 3000,
        reportFailure: true,
        // 代理 fake-IP 放行开关（宿主默认 true）：只放行 198.18.0.0/15 这一段，
        // 其它内网/回环仍拒绝。客户端只负责展示，保存时随整份 config 提交。
        allowFakeIp: true,
        sources: [
          { name: "B 站热门", url: "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all", type: "json" },
          { name: "V2EX 热帖", url: "https://www.v2ex.com/api/topics/hot.json", type: "json" },
          { name: "知乎日报", url: "https://news-at.zhihu.com/api/4/news/latest", type: "json" },
          { name: "少数派", url: "https://sspai.com/feed", type: "rss" },
          { name: "36 氪", url: "https://36kr.com/feed", type: "rss" },
          { name: "IT 之家", url: "https://www.ithome.com/rss/", type: "rss" },
          { name: "中文维基随机", url: "https://zh.wikipedia.org/api/rest_v1/page/random/summary", type: "json" },
        ],
      },
      whisper: { enabled: false, intervalMin: 60, quietSameAsRoam: true },
    };

    // =========================================================================
    // 通用小工具（全部防御式：失败返回兜底值，不抛）
    // =========================================================================

    /** 异常 → 单行中文/英文文案。 */
    function errorText(e) {
      if (e === null || e === undefined) return "未知错误";
      if (typeof e === "string") return e;
      if (e.message) return String(e.message);
      return String(e);
    }

    function warn(...args) {
      try {
        console.warn("[dsh-whale-chat]", ...args);
      } catch (_) {
        /* 控制台都没了就算了 */
      }
    }

    function isObject(v) {
      return v !== null && typeof v === "object" && !Array.isArray(v);
    }

    function cloneJson(v) {
      try {
        return JSON.parse(JSON.stringify(v));
      } catch (_) {
        return isObject(v) ? Object.assign({}, v) : v;
      }
    }

    /** 深合并：patch 覆盖 base；数组整体替换（来源清单就是整体替换的语义）。 */
    function mergeDeep(base, patch) {
      if (!isObject(patch)) return isObject(base) ? cloneJson(base) : base;
      const out = isObject(base) ? cloneJson(base) : {};
      for (const key of Object.keys(patch)) {
        const value = patch[key];
        if (value === undefined) continue;
        if (isObject(value)) out[key] = mergeDeep(out[key], value);
        else if (Array.isArray(value)) out[key] = cloneJson(value);
        else out[key] = value;
      }
      return out;
    }

    function clampNumber(v, min, max, fallback) {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    }

    function clampInt(v, min, max, fallback) {
      return Math.round(clampNumber(v, min, max, fallback));
    }

    function pick(list) {
      try {
        if (!Array.isArray(list) || list.length === 0) return null;
        return list[Math.floor(Math.random() * list.length)];
      } catch (_) {
        return null;
      }
    }

    function textLength(v) {
      return typeof v === "string" ? v.length : 0;
    }

    function isNum(v) {
      return typeof v === "number" && Number.isFinite(v);
    }

    function videoSrc(name) {
      return WEBM_BASE + encodeURIComponent(String(name || "")) + ".webm";
    }

    function fontStackOf(name) {
      return name === "system" ? FONT_STACKS.system : FONT_STACKS.candy;
    }

    /** 模型对象 → `provider / model` 文案（缺字段容错）。 */
    function modelLabel(model) {
      if (!model || typeof model !== "object") return "";
      const provider = typeof model.provider === "string" ? model.provider : "";
      const name = typeof model.model === "string" ? model.model : "";
      if (!provider && !name) return "";
      return (provider ? provider + " / " : "") + name;
    }

    /** ISO 时间 → 本地 `YYYY/MM/DD HH:MM:SS`；解析失败原样显示。 */
    function formatWhen(value) {
      if (!value) return "—";
      const date = new Date(value);
      if (isNaN(date.getTime())) return String(value);
      try {
        return date.toLocaleString("zh-CN", { hour12: false });
      } catch (_) {
        return date.toISOString();
      }
    }

    /**
     * 深色主题探测：读 body / html 的计算背景亮度，读不到再退回系统配色偏好。
     * 为什么不只用 prefers-color-scheme：DSH 的主题是应用内设置，可能和系统
     * 不一致；面板与气泡必须跟 DSH 本身一致才不刺眼。
     */
    function detectDarkTheme() {
      try {
        const readLum = (el) => {
          if (!el) return null;
          const bg = getComputedStyle(el).backgroundColor || "";
          const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/.exec(bg);
          if (!m) return null;
          const alpha = m[4] === undefined ? 1 : Number(m[4]);
          if (!Number.isFinite(alpha) || alpha < 0.05) return null;
          const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
          return lum < 128;
        };
        const bodyDark = readLum(document.body);
        if (bodyDark !== null) return bodyDark;
        const htmlDark = readLum(document.documentElement);
        if (htmlDark !== null) return htmlDark;
      } catch (_) {
        /* 读不到计算样式就继续走系统偏好 */
      }
      try {
        return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      } catch (_) {
        return false;
      }
    }

    // =========================================================================
    // 网络层：统一中文错误、超时、credentials same-origin
    // =========================================================================

    function apiUrl(path) {
      return path.charAt(0) === "/" ? API_BASE + path : API_BASE + "/" + path;
    }

    /**
     * 唯一网络出口。
     * 返回 Promise<data>：HTTP 非 2xx / 非 JSON / ok:false 一律 reject 成中文 Error。
     * reject 时带上 `err.data`（原始 JSON）、`err.reason`、`err.status`：
     * 像 `/api/roam` 的「忙」是 HTTP 200 + `{ok:false, skipped:'running', error}`，
     * 调用方需要从 `err.data` 里取 skipped 来区分「上一次还没回来」和真正失败。
     */
    function requestJson(path, options) {
      const opts = options || {};
      const timeout = typeof opts.timeout === "number" ? opts.timeout : 15000;
      const init = {
        method: opts.method || "GET",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        cache: "no-store",
      };
      if (opts.body !== undefined) {
        try {
          init.body = JSON.stringify(opts.body);
        } catch (e) {
          return Promise.reject(new Error("请求内容无法序列化"));
        }
      }

      let controller = null;
      if (typeof AbortController !== "undefined") {
        try {
          controller = new AbortController();
          init.signal = controller.signal;
        } catch (_) {
          controller = null;
        }
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          fn(value);
        };
        if (controller) {
          timer = setTimeout(() => {
            try {
              controller.abort();
            } catch (_) {
              /* ignore */
            }
          }, timeout);
        }

        let req;
        try {
          req = fetch(apiUrl(path), init);
        } catch (e) {
          finish(reject, new Error("网络请求发起失败：" + errorText(e)));
          return;
        }

        req.then(
          (resp) => {
            resp.text().then(
              (raw) => {
                let data = null;
                if (raw) {
                  try {
                    data = JSON.parse(raw);
                  } catch (_) {
                    data = null;
                  }
                }
                if (!resp.ok) {
                  let msg = "";
                  if (data && typeof data.error === "string" && data.error) msg = data.error;
                  else if (resp.status === 403) msg = "被 DSH 的信任栅栏拒绝了（请从 DSH 界面里操作）";
                  else msg = "HTTP " + resp.status;
                  const err = new Error(msg);
                  err.status = resp.status;
                  err.data = data;
                  finish(reject, err);
                  return;
                }
                if (!data || typeof data !== "object") {
                  finish(reject, new Error("服务器返回的不是 JSON（插件可能没装好）"));
                  return;
                }
                if (data.ok === false) {
                  const msg =
                    (typeof data.error === "string" && data.error) ||
                    (typeof data.reason === "string" && data.reason) ||
                    "操作没有成功";
                  const err = new Error(msg);
                  err.reason = data.reason;
                  err.data = data;
                  finish(reject, err);
                  return;
                }
                finish(resolve, data);
              },
              (e) => finish(reject, new Error("读取响应失败：" + errorText(e))),
            );
          },
          (e) => {
            if (e && e.name === "AbortError") {
              finish(reject, new Error("请求超时（" + Math.round(timeout / 1000) + " 秒）"));
              return;
            }
            finish(reject, new Error("连不上鲸聊后台：" + errorText(e)));
          },
        );
      });
    }

    function apiGet(path, timeout) {
      return requestJson(path, { method: "GET", timeout: timeout });
    }

    function apiPost(path, body, timeout) {
      return requestJson(path, { method: "POST", body: body === undefined ? {} : body, timeout: timeout });
    }

    // =========================================================================
    // 样式：只注入一次；所有类名以 wc- 前缀做隔离，绝不碰 DSH 全局样式
    // =========================================================================

    const CSS = `
/* 上首软糖体：只服务桌宠气泡与对话面板；设置页保持 DSH 原生排版 */
@font-face{font-family:"WhaleChatCandy";src:url("${FONT_URL}") format("truetype");font-display:swap;font-weight:400;font-style:normal}

/* ============ 桌宠浮层（shell.overlay） ============ */
.wc-overlay{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:var(--wc-font,"WhaleChatCandy",system-ui,sans-serif);-webkit-font-smoothing:antialiased}
.wc-overlay *,.wc-s *{box-sizing:border-box}
.wc-anchor{position:fixed;width:var(--wc-size,320px);height:calc(var(--wc-size,320px)*9/16);pointer-events:none}
.wc-anchor[data-corner="bottom-right"]{right:var(--wc-mx,24px);bottom:var(--wc-my,96px)}
.wc-anchor[data-corner="bottom-left"]{left:var(--wc-mx,24px);bottom:var(--wc-my,96px)}
.wc-anchor[data-corner="top-right"]{right:var(--wc-mx,24px);top:var(--wc-my,96px)}
.wc-anchor[data-corner="top-left"]{left:var(--wc-mx,24px);top:var(--wc-my,96px)}

/* 宠物本体：只有这里接管指针事件；容器本身 pointer-events:none 不挡 DSH 页面 */
.wc-petwrap{position:absolute;inset:0;pointer-events:auto;cursor:grab;touch-action:none;-webkit-user-select:none;user-select:none;border-radius:18px;outline:none;transition:transform .2s ease}
.wc-petwrap:hover{transform:translateY(-4px)}
.wc-petwrap.is-dragging{cursor:grabbing;transition:none;transform:none}
.wc-petwrap:focus-visible{box-shadow:0 0 0 2px rgba(110,150,255,.85),0 0 0 6px rgba(110,150,255,.22)}
.wc-video{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;transform:translateX(var(--wc-shift,0px)) scaleX(var(--wc-flip,1));transition:transform .45s cubic-bezier(.22,.61,.36,1)}
.wc-fallback{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;user-select:none}
.wc-fallback-emoji{display:flex;align-items:center;justify-content:center;font-size:calc(var(--wc-size,320px)*.3);line-height:1;text-shadow:0 6px 18px rgba(0,0,0,.18)}

/* 💬 打开面板：贴宠物内侧，浅显但可聚焦 */
.wc-chatbtn{position:absolute;top:4px;width:32px;height:32px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:50%;border:1px solid rgba(127,127,127,.3);background:rgba(255,255,255,.92);color:#2b2f36;font-size:15px;line-height:1;cursor:pointer;pointer-events:auto;opacity:.5;box-shadow:0 2px 8px rgba(0,0,0,.12);transition:opacity .15s ease,transform .15s ease;z-index:8}
.wc-chatbtn:hover,.wc-chatbtn:focus-visible{opacity:1;transform:scale(1.06)}
.wc-anchor[data-corner$="right"] .wc-chatbtn{right:calc(100% + 6px)}
.wc-anchor[data-corner$="left"] .wc-chatbtn{left:calc(100% + 6px)}
[data-wc-dark="1"] .wc-chatbtn{background:rgba(40,44,52,.94);color:#eef1f6;border-color:rgba(255,255,255,.18)}

/* 未读角标 */
.wc-badge{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;border:2px solid rgba(255,255,255,.92);background:#e5484d;color:#fff;font-family:system-ui,sans-serif;font-size:11px;font-weight:600;line-height:16px;text-align:center;cursor:pointer;pointer-events:auto;z-index:9}
[data-wc-dark="1"] .wc-badge{border-color:rgba(22,24,28,.9)}

/* 后台连接异常的警示点（不打扰，只提示） */
.wc-warn{position:absolute;top:-2px;left:-2px;width:10px;height:10px;border-radius:50%;background:#f0a020;box-shadow:0 0 0 2px rgba(255,255,255,.75);pointer-events:none;z-index:9}

/* 气泡：浅色=白底深字；深色=深底浅字（用 data-wc-dark 跟 DSH 主题走） */
.wc-bubble{position:absolute;bottom:calc(100% + 12px);width:max-content;min-width:96px;max-width:min(300px,calc(100vw - 24px));padding:10px 13px;border-radius:14px;background:rgba(255,255,255,.97);color:#25282e;font-size:14px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 10px 28px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.08);opacity:0;pointer-events:none;z-index:6;transition:opacity .22s ease,transform .22s ease}
.wc-anchor[data-corner$="right"] .wc-bubble{right:0}
.wc-anchor[data-corner$="left"] .wc-bubble{left:0}
.wc-bubble::after{content:"";position:absolute;bottom:-6px;width:13px;height:13px;background:inherit;transform:rotate(45deg);border-radius:2px}
.wc-anchor[data-corner$="right"] .wc-bubble::after{right:26px}
.wc-anchor[data-corner$="left"] .wc-bubble::after{left:26px}
.wc-bubble.is-on{opacity:1;pointer-events:auto;cursor:pointer}
.wc-bubble-text{display:block}
.wc-bubble-src{display:inline-block;margin-top:6px;font-size:12px;line-height:1.5;color:#3b6fd4;text-decoration:none;border-bottom:1px dashed rgba(59,111,212,.5);pointer-events:auto}
.wc-bubble-src:hover{color:#2f5cb3}
[data-wc-dark="1"] .wc-bubble{background:rgba(38,41,48,.97);color:#eef1f6;box-shadow:0 10px 30px rgba(0,0,0,.55),0 1px 3px rgba(0,0,0,.4)}
[data-wc-dark="1"] .wc-bubble-src{color:#8db4ff;border-bottom-color:rgba(141,180,255,.5)}

/* ============ 对话面板 ============ */
.wc-panel{position:fixed;width:340px;max-width:calc(100vw - 20px);display:flex;flex-direction:column;min-height:0;border-radius:16px;overflow:hidden;pointer-events:auto;z-index:2147483002;background:#fff;color:#1f2329;border:1px solid rgba(127,127,127,.22);box-shadow:0 18px 52px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.08);font-family:var(--wc-font,"WhaleChatCandy",system-ui,sans-serif)}
[data-wc-dark="1"] .wc-panel{background:#24272e;color:#eef1f6;border-color:rgba(255,255,255,.14);box-shadow:0 18px 52px rgba(0,0,0,.6)}
.wc-panel-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(127,127,127,.16)}
.wc-panel-title{flex:1;min-width:0;font-size:14px;font-weight:600;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wc-iconbtn{flex:none;width:26px;height:26px;padding:0;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;color:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.7}
.wc-iconbtn:hover{opacity:1;background:rgba(127,127,127,.14)}
.wc-msglist{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:9px;scrollbar-width:thin}
.wc-msg{display:flex;flex-direction:column;align-items:flex-start;max-width:100%}
.wc-msg-user{align-items:flex-end}
.wc-msg-body{max-width:88%;padding:8px 11px;border-radius:12px;font-size:13.5px;line-height:1.58;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.wc-msg-user .wc-msg-body{background:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff);border-bottom-right-radius:4px}
.wc-msg-assistant .wc-msg-body{background:rgba(127,127,127,.14);color:inherit;border-bottom-left-radius:4px}
[data-wc-dark="1"] .wc-msg-assistant .wc-msg-body{background:rgba(255,255,255,.1)}
.wc-msg-error .wc-msg-body{background:rgba(220,64,64,.12);color:var(--dsw-alias-state-error-primary,#d33);border:1px solid rgba(220,64,64,.35);font-size:12.5px}
.wc-msg-note .wc-msg-body{background:rgba(64,160,110,.14);font-size:12.5px}
.wc-msg-meta{margin:2px 4px 0;font-size:11px;line-height:1.4;color:rgba(127,127,127,.95)}
.wc-typing{display:inline-flex;align-items:center;gap:5px;padding:9px 12px;border-radius:12px;border-bottom-left-radius:4px;background:rgba(127,127,127,.14);font-size:12.5px;color:rgba(127,127,127,1)}
[data-wc-dark="1"] .wc-typing{background:rgba(255,255,255,.1)}
.wc-typing span{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.3;animation:wcTyping 1.2s infinite ease-in-out}
.wc-typing span:nth-child(2){animation-delay:.18s}
.wc-typing span:nth-child(3){animation-delay:.36s}
.wc-typing em{font-style:normal;margin-left:2px;opacity:.9}
@keyframes wcTyping{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}
.wc-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px 18px;text-align:center;font-size:13px;color:rgba(127,127,127,1)}
.wc-empty-emoji{font-size:34px;line-height:1}
.wc-empty-sub{font-size:11.5px;line-height:1.6;opacity:.9}
.wc-composer{flex:none;display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid rgba(127,127,127,.16)}
.wc-textarea{flex:1;min-width:0;min-height:34px;max-height:96px;padding:7px 10px;border-radius:10px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;font-family:inherit;font-size:13.5px;line-height:1.5;resize:none;outline:none;overflow-y:auto}
.wc-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.wc-send{flex:none;height:34px;padding:0 15px;border:none;border-radius:10px;background:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff);font-family:inherit;font-size:13px;cursor:pointer}
.wc-send:disabled{opacity:.5;cursor:default}
.wc-panel-err{flex:none;padding:0 12px 8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#d33);white-space:pre-wrap}
.wc-panel-notice{flex:none;padding:0 12px 8px;font-size:11.5px;line-height:1.5;color:rgba(127,127,127,.95)}
.wc-panel-foot{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:2px 12px 10px;font-size:11.5px;line-height:1.5;color:rgba(127,127,127,.95)}
.wc-foot-grow{flex:1;min-width:8px}
.wc-linkbtn{padding:2px 5px;border:none;border-radius:6px;background:transparent;color:inherit;font-family:inherit;font-size:11.5px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.wc-linkbtn:hover{background:rgba(127,127,127,.14)}
.wc-linkbtn:disabled{opacity:.5;cursor:default}
.wc-confirm{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-state-error-primary,#d33)}

/* ============ 设置页（settings.section） ============ */
.wc-s{max-width:780px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px}
.wc-s-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.wc-s-intro{margin:0 0 6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8a9099)}
.wc-s-intro code,.wc-s-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.wc-s-group{margin-top:16px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28))}
.wc-s-group:first-of-type{margin-top:10px}
.wc-s-group-title{margin:0 0 2px;font-size:13px;font-weight:600;line-height:20px}
.wc-s-group-desc{margin:0 0 6px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a9099)}
.wc-s-rows{display:flex;flex-direction:column}
.wc-s-row{display:flex;justify-content:space-between;align-items:flex-start;gap:10px 20px;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));flex-wrap:wrap}
.wc-s-row:last-child{border-bottom:none}
.wc-s-row-label{flex:1 1 220px;min-width:190px}
.wc-s-label{font-size:13px;line-height:19px}
.wc-s-hint{margin-top:3px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a9099);white-space:pre-line}
.wc-s-control{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:180px;max-width:100%}
.wc-s-control-row{flex-direction:row;justify-content:flex-end;align-items:center;min-width:60px}
.wc-s-row.is-wide{flex-direction:column;align-items:stretch}
.wc-s-row.is-wide .wc-s-control{width:100%}
.wc-s-input,.wc-s-select,.wc-s-textarea{background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;color:var(--dsw-alias-label-primary,#1f2329);font-family:inherit;font-size:12.5px;outline:none;min-width:0}
.wc-s-input,.wc-s-select{height:28px;padding:0 8px}
.wc-s-textarea{padding:7px 9px;line-height:1.55;font-size:12.5px;resize:vertical;min-height:76px}
.wc-s-input:focus-visible,.wc-s-select:focus-visible,.wc-s-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.wc-s-input.is-bad,.wc-s-select.is-bad,.wc-s-textarea.is-bad{border-color:var(--dsw-alias-state-error-primary,#d33)}
.wc-s-err{margin-top:2px;max-width:440px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-error-primary,#d33);white-space:pre-line}
.wc-s-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wc-s-inline .wc-s-input.is-num{width:92px;min-width:92px}
.wc-s-range{flex:1;min-width:120px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.wc-s-check{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer}
.wc-s-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28))}
.wc-s-btn{height:30px;padding:0 14px;border:none;border-radius:6px;background:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff);font-family:inherit;font-size:12.5px;cursor:pointer}
.wc-s-btn:disabled{opacity:.5;cursor:default}
.wc-s-btn.is-2{background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-primary,#1f2329)}
.wc-s-btn.is-danger{background:transparent;border:1px solid var(--dsw-alias-state-error-primary,#d33);color:var(--dsw-alias-state-error-primary,#d33)}
.wc-s-out{margin-top:10px;padding:10px 12px;max-height:260px;overflow:auto;border-radius:8px;background:rgba(127,127,127,.08);color:var(--dsw-alias-label-secondary,#5a6270);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-word}
.wc-s-badbox{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d33);white-space:pre-line}
.wc-s-dirty{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;color:#e8952f}
.wc-s-kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:2px 0 0;font-size:12px;line-height:18px}
.wc-s-kv dt{color:var(--dsw-alias-label-tertiary,#8a9099)}
.wc-s-kv dd{margin:0;color:var(--dsw-alias-label-primary,#1f2329);word-break:break-all}
.wc-s-note{margin-top:4px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a9099)}
.wc-s-src-errs{margin-top:4px}

@media (prefers-reduced-motion: reduce){.wc-video,.wc-petwrap,.wc-bubble{transition:none}.wc-typing span{animation:none;opacity:.6}}
`;

    /** 注入样式（只注入一次；卸载组件时故意不移除，避免反复挂载闪烁）。 */
    function ensureStyle() {
      if (typeof document === "undefined" || !document.head) return;
      try {
        if (document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') !== null) return;
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-whale-chat";
        tag.dataset.pluginCss = CSS_TAG;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (e) {
        warn("注入样式失败：", errorText(e));
      }
    }

    // =========================================================================
    // 桌宠浮层
    // =========================================================================

    /** 外观配置归一化（宿主字段缺失/越界时也不要渲染坏掉）。 */
    function normalizeAppearance(raw) {
      const a = isObject(raw) ? raw : {};
      return {
        enabled: a.enabled !== false,
        size: clampInt(a.size, 160, 640, 320),
        corner: CORNERS.indexOf(a.corner) >= 0 ? a.corner : "bottom-right",
        marginX: clampInt(a.marginX, 0, 1000, 24),
        marginY: clampInt(a.marginY, 0, 1000, 96),
        bubbleSeconds: clampNumber(a.bubbleSeconds, 4, 120, 14),
        fontFamily: a.fontFamily === "system" ? "system" : "candy",
      };
    }

    function WhaleChatOverlay() {
      ensureStyle();

      // ── 配置 / 人设（60s 刷新一次，设置页保存后会广播事件即时刷新） ──────
      const [appearance, setAppearance] = useState(() => normalizeAppearance(DEFAULT_CONFIG.appearance));
      const appearanceRef = useRef(appearance);
      appearanceRef.current = appearance;

      const [persona, setPersona] = useState(() => ({
        name: DEFAULT_CONFIG.persona.name,
        ownerTitle: DEFAULT_CONFIG.persona.ownerTitle,
      }));
      const personaRef = useRef(persona);
      personaRef.current = persona;

      const [dark, setDark] = useState(false);

      // ── 动画状态：name = 当前 webm；phase = 播完后怎么接；nonce 用来重播同名动画 ──
      const [anim, setAnim] = useState(() => ({ name: ANIM.idle[0], phase: "idle", nonce: 0 }));
      const animRef = useRef(anim);
      animRef.current = anim;

      const [sway, setSway] = useState({ x: 0, flip: false });
      const [bubble, setBubble] = useState(null);
      const [unread, setUnread] = useState(0);
      const unreadRef = useRef(0);
      unreadRef.current = unread;
      const [failStreak, setFailStreak] = useState(0);
      const [dragging, setDragging] = useState(false);
      const draggingRef = useRef(false);
      draggingRef.current = dragging;
      const [panelOpen, setPanelOpen] = useState(false);
      const [videoFailed, setVideoFailed] = useState(false);
      const [iconFailed, setIconFailed] = useState(false);
      const [panelPos, setPanelPos] = useState({ left: 24, top: 120, height: 460 });

      // ── refs：元素 / 定时器 / 轮询游标 / 异步存活标记 ─────────────────────
      const videoRef = useRef(null);
      const anchorRef = useRef(null);
      const bubbleTimerRef = useRef(null);
      const clickTimerRef = useRef(null);
      const thinkingTimerRef = useRef(null);
      const saveTimerRef = useRef(null);
      const pendingSaveRef = useRef(null);
      const syncSettingsRef = useRef(null);
      const mountedRef = useRef(true);
      const cursorRef = useRef(0); // 已同步到的消息 id
      const lastMsgRef = useRef(null); // 最近一条新增主动消息（点宠物时弹气泡用）
      const baselineMsgRef = useRef(null); // 首次基线里取到的最新一条（不弹，但可点开看）
      const suppressClickRef = useRef(false); // 刚拖完，别把 pointerup 当成点击
      const dragRef = useRef({
        active: false,
        dragging: false,
        pointerId: null,
        startX: 0,
        startY: 0,
        offX: 0,
        offY: 0,
        lastX: 0,
        lastY: 0,
      });

      // ── 挂载标记（StrictMode 双挂载也安全：effect 里重新置 true） ─────────
      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      // =====================================================================
      // 动画链
      // =====================================================================

      const playAnim = useCallback((name, phase) => {
        if (typeof name !== "string" || name === "") return;
        setAnim((prev) => ({ name: name, phase: phase || prev.phase, nonce: prev.nonce + 1 }));
      }, []);

      /** 位移小动作：朝「远离所贴角落」的方向挪 40–120px，并水平镜像，绝不越出视口。 */
      const startMove = useCallback(
        (name) => {
          const right = /right$/.test(appearanceRef.current.corner);
          const dir = right ? -1 : 1;
          let room = 60;
          try {
            const el = anchorRef.current;
            if (el) {
              const rect = el.getBoundingClientRect();
              room = dir < 0 ? rect.left - 8 : window.innerWidth - rect.right - 8;
            }
          } catch (_) {
            room = 60;
          }
          room = Math.max(0, Math.min(120, room));
          const dist = room >= 24 ? Math.round(40 + Math.random() * Math.min(80, room - 24)) : 0;
          setSway({ x: dir * dist, flip: dir < 0 });
          playAnim(name, "move");
        },
        [playAnim],
      );

      const resetSway = useCallback(() => setSway({ x: 0, flip: false }), []);

      /** 由外部事件驱动的动画阶段（发消息 / 收回复 / 主动消息 / 点击 / 拖拽）。 */
      const playPhase = useCallback(
        (phase) => {
          try {
            if (phase === "thinking") {
              playAnim(pick(ANIM.thinking), "thinking");
              // 看门狗：面板中途被关掉/请求悬挂时，别让宠物永远「思考中」
              if (thinkingTimerRef.current !== null) clearTimeout(thinkingTimerRef.current);
              thinkingTimerRef.current = window.setTimeout(() => {
                thinkingTimerRef.current = null;
                try {
                  if (animRef.current.phase === "thinking") playAnim(pick(ANIM.idle), "idle");
                } catch (_) {
                  /* ignore */
                }
              }, 65000);
              return;
            }
            if (thinkingTimerRef.current !== null) {
              clearTimeout(thinkingTimerRef.current);
              thinkingTimerRef.current = null;
            }
            if (phase === "talk") playAnim(pick(ANIM.talk), "talk");
            else if (phase === "roam") playAnim(pick(ANIM.roamWalk), "roam-walk");
            else if (phase === "happy") playAnim(pick(ANIM.clicks), "happy");
            else if (phase === "sad") playAnim(pick(ANIM.sad), "sad");
            else if (phase === "drag") playAnim(pick(ANIM.drag), "drag");
            else playAnim(pick(ANIM.idle), "idle");
          } catch (e) {
            warn("切换动画失败：", errorText(e));
          }
        },
        [playAnim],
      );

      /** 一段动画播完 → 按阶段决定下一段（对应 SPEC §6.1 状态机）。 */
      const handleEnded = useCallback(() => {
        try {
          const cur = animRef.current;
          const phase = cur.phase;
          if (phase === "thinking" || phase === "drag") return; // 这两类循环播放，不会 ended
          if (phase === "idle") {
            const roll = Math.random() * 100;
            if (roll < IDLE_WEIGHTS.idle) playAnim(pick(ANIM.idle), "idle");
            else if (roll < IDLE_WEIGHTS.idle + IDLE_WEIGHTS.actions) playAnim(pick(ANIM.actions), "action");
            else startMove(pick(ANIM.moves));
            return;
          }
          if (phase === "move") {
            resetSway();
            playAnim(pick(ANIM.idle), "idle");
            return;
          }
          if (phase === "roam-walk") {
            playAnim(pick(ANIM.roamLook), "roam-look");
            return;
          }
          if (phase === "action" || phase === "talk" || phase === "happy" || phase === "sad" || phase === "roam-look") {
            playAnim(pick(ANIM.idle), "idle");
            return;
          }
          playAnim(pick(ANIM.idle), "idle");
        } catch (e) {
          warn("动画链异常：", errorText(e));
        }
      }, [playAnim, startMove, resetSway]);

      // 换 src 后显式 play 一次：muted + autoplay 一般能自动播，但切 src 时不一定。
      // 同一个动画重播（nonce 变化）靠 currentTime=0 而不是重建 video 元素。
      useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        try {
          v.currentTime = 0;
        } catch (_) {
          /* 元数据还没到时可能抛，忽略：play() 会从 0 开始 */
        }
        try {
          const p = v.play();
          if (p && typeof p.then === "function") p.catch(() => {});
        } catch (_) {
          /* 自动播放被拒绝就算了，画面会停在第一帧 */
        }
      }, [anim.name, anim.nonce, appearance.enabled, videoFailed]);

      // 视频加载失败：退化为静态 icon；30 秒后重试一次（宿主可能刚起来）。
      useEffect(() => {
        if (!videoFailed) return undefined;
        const timer = window.setTimeout(() => {
          try {
            setVideoFailed(false);
          } catch (_) {
            /* ignore */
          }
        }, 30000);
        return () => window.clearTimeout(timer);
      }, [videoFailed]);

      // 清理：动画看门狗 / 气泡 / 单击延迟 / 拖动保存。
      useEffect(() => {
        return () => {
          if (thinkingTimerRef.current !== null) window.clearTimeout(thinkingTimerRef.current);
          if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
          if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
          if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        };
      }, []);

      // =====================================================================
      // 主题探测（面板/气泡的深浅色跟随 DSH，不跟系统设置死绑定）
      // =====================================================================

      useEffect(() => {
        const update = () => {
          try {
            setDark(detectDarkTheme());
          } catch (_) {
            /* ignore */
          }
        };
        update();
        let mq = null;
        try {
          mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
          if (mq && mq.addEventListener) mq.addEventListener("change", update);
        } catch (_) {
          mq = null;
        }
        let observer = null;
        try {
          if (typeof MutationObserver !== "undefined" && document.documentElement) {
            observer = new MutationObserver(update);
            observer.observe(document.documentElement, {
              attributes: true,
              attributeFilter: ["class", "style", "data-theme", "data-color-scheme"],
            });
            if (document.body) {
              observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
            }
          }
        } catch (_) {
          observer = null;
        }
        // DSH 切主题未必改 html 属性；30s 兜底重探一次（只读计算样式，开销可忽略）
        const timer = window.setInterval(update, 30000);
        return () => {
          window.clearInterval(timer);
          try {
            if (mq && mq.removeEventListener) mq.removeEventListener("change", update);
          } catch (_) {
            /* ignore */
          }
          try {
            if (observer) observer.disconnect();
          } catch (_) {
            /* ignore */
          }
        };
      }, []);

      // =====================================================================
      // 轮询主动消息 + 配置同步
      // =====================================================================

      useEffect(() => {
        let alive = true;
        let timer = null;
        let delay = POLL_BASE_MS;
        let fails = 0;
        let cursor = null; // null = 还没取基线

        const schedule = () => {
          if (!alive) return;
          timer = window.setTimeout(tick, delay);
        };

        const tick = async () => {
          if (!alive) return;
          try {
            const path =
              cursor === null
                ? "/api/messages?afterId=0&limit=100"
                : "/api/messages?afterId=" + encodeURIComponent(String(cursor)) + "&limit=20";
            const data = await apiGet(path, 12000);
            if (!alive) return;
            const items = Array.isArray(data.items) ? data.items : [];
            const serverCursor = Number(data.cursor);

            if (cursor === null) {
              // 首次只同步基线：不弹任何历史气泡（避免刷屏）。
              // 宿主的 cursor 是「当前队列全局最大 id」，不是本批最后一条，
              // 所以 cursor 直接取服务端值（没有才退回本批最大 id）。
              let maxItemId = 0;
              for (const item of items) {
                const id = Number(item && item.id);
                if (Number.isFinite(id) && id > maxItemId) maxItemId = id;
              }
              cursor = Number.isFinite(serverCursor) && serverCursor > 0 ? serverCursor : maxItemId;
              cursorRef.current = cursor;

              // 点角标时要展示「最新一条」，而 afterId=0 返回的是最旧的 ≤20 条。
              // 再按 maxId 往前取 20 条（id > maxId-20），升序结果的最后一条
              // 必然就是队尾最新（id 是整数，一个 20 宽窗口最多装 20 条）。
              let latest = items.length > 0 ? items[items.length - 1] : null;
              if (cursor > 0) {
                try {
                  const tail = await apiGet(
                    "/api/messages?afterId=" + encodeURIComponent(String(Math.max(0, cursor - 20))) + "&limit=20",
                    12000,
                  );
                  if (!alive) return;
                  const tailItems = Array.isArray(tail.items) ? tail.items : [];
                  if (tailItems.length > 0) latest = tailItems[tailItems.length - 1];
                } catch (_) {
                  // 取不到队尾就用第一批的最后一条兜底；不弹历史、不影响基线
                }
              }
              baselineMsgRef.current = latest;
              setUnread(Math.max(0, Math.floor(Number(data.unreadCount) || 0)));
            } else {
              let maxId = cursor;
              for (const item of items) {
                const id = Number(item && item.id);
                if (Number.isFinite(id) && id > maxId) maxId = id;
              }
              const fresh = items.filter((item) => Number(item && item.id) > cursor);
              if (Number.isFinite(serverCursor) && serverCursor > maxId) maxId = serverCursor;
              cursor = maxId;
              cursorRef.current = cursor;
              if (fresh.length > 0) {
                const first = fresh[0];
                lastMsgRef.current = first;
                // 先显示第一条（不刷屏），未读数取服务端真值
                if (typeof incomingRef.current === "function") incomingRef.current(first);
              }
              if (Number.isFinite(Number(data.unreadCount))) {
                setUnread(Math.max(0, Math.floor(Number(data.unreadCount))));
              }
            }
            fails = 0;
            delay = POLL_BASE_MS;
            setFailStreak(0);
          } catch (_) {
            if (!alive) return;
            fails += 1;
            setFailStreak(fails);
            delay = Math.min(POLL_MAX_MS, Math.max(POLL_BASE_MS * 2, Math.round(delay * 1.6)));
          }
          schedule();
        };

        // 挂载后 400ms 取基线，避开首屏渲染最忙的时候。
        timer = window.setTimeout(tick, 400);
        return () => {
          alive = false;
          if (timer !== null) window.clearTimeout(timer);
        };
      }, []);

      // 主动消息 → 气泡 + 动画（用 ref 拿最新实现，避免轮询 effect 依赖变化）
      const incomingRef = useRef(null);
      incomingRef.current = (item) => {
        try {
          if (!item || typeof item !== "object") return;
          const text = typeof item.text === "string" ? item.text : "";
          if (!text) return;
          const source = isObject(item.source) && item.source.url ? item.source : null;
          showBubbleRef.current({ text: text, source: source, kind: item.kind });
          if (item.kind === "error") playPhase("sad");
          else playPhase("roam");
        } catch (e) {
          warn("处理主动消息失败：", errorText(e));
        }
      };

      // =====================================================================
      // 气泡
      // =====================================================================

      const showBubbleRef = useRef(null);
      const showBubble = useCallback((payload) => {
        try {
          const text = payload && typeof payload.text === "string" ? payload.text.trim() : "";
          if (!text) return;
          if (bubbleTimerRef.current !== null) {
            clearTimeout(bubbleTimerRef.current);
            bubbleTimerRef.current = null;
          }
          const source = isObject(payload.source) && typeof payload.source.url === "string" && payload.source.url ? payload.source : null;
          setBubble({ text: text, source: source, kind: payload.kind || "chat" });
          const seconds = clampNumber(appearanceRef.current.bubbleSeconds, 4, 120, 14);
          bubbleTimerRef.current = window.setTimeout(() => {
            bubbleTimerRef.current = null;
            try {
              setBubble(null);
            } catch (_) {
              /* 卸载后 setState 也不会被调用：定时器在清理里已清 */
            }
          }, seconds * 1000);
        } catch (e) {
          warn("显示气泡失败：", errorText(e));
        }
      }, []);
      showBubbleRef.current = showBubble;

      // =====================================================================
      // 配置同步
      // =====================================================================

      const syncSettings = useCallback(async () => {
        if (draggingRef.current || saveTimerRef.current !== null) return; // 别覆盖刚拖出来的位置
        try {
          const data = await apiGet("/api/settings", 20000);
          if (!mountedRef.current) return;
          const cfg = isObject(data.config) ? data.config : {};
          setAppearance(normalizeAppearance(cfg.appearance));
          const p = isObject(cfg.persona) ? cfg.persona : {};
          setPersona({
            name: typeof p.name === "string" && p.name ? p.name : DEFAULT_CONFIG.persona.name,
            ownerTitle:
              typeof p.ownerTitle === "string" && p.ownerTitle ? p.ownerTitle : DEFAULT_CONFIG.persona.ownerTitle,
          });
        } catch (_) {
          // 静默：桌宠继续用本地默认值显示，不能让「设置读不到」变成白屏
        }
      }, []);

      syncSettingsRef.current = syncSettings;

      useEffect(() => {
        let alive = true;
        const run = () => {
          if (!alive) return;
          syncSettingsRef.current && syncSettingsRef.current();
        };
        run();
        const timer = window.setInterval(run, SETTINGS_SYNC_MS);
        const onFocus = () => run();
        const onChanged = () => run();
        window.addEventListener("focus", onFocus);
        window.addEventListener("dsh-whale-chat:settings-changed", onChanged);
        return () => {
          alive = false;
          window.clearInterval(timer);
          window.removeEventListener("focus", onFocus);
          window.removeEventListener("dsh-whale-chat:settings-changed", onChanged);
        };
      }, []);

      // =====================================================================
      // 未读 / 已读
      // =====================================================================

      const markRead = useCallback(async () => {
        const id = cursorRef.current;
        try {
          setUnread(0);
        } catch (_) {
          /* ignore */
        }
        if (!id || id <= 0) return;
        try {
          const data = await apiPost("/api/messages/read", { id: id }, 15000);
          if (!mountedRef.current) return;
          if (Number.isFinite(Number(data.unreadCount))) setUnread(Math.max(0, Math.floor(Number(data.unreadCount))));
        } catch (_) {
          // 静默：下一次轮询会用服务端的 unreadCount 校正
        }
      }, []);

      const openPanel = useCallback(() => {
        setPanelOpen(true);
        if (unreadRef.current > 0) markRead();
      }, [markRead]);

      const closePanel = useCallback(() => {
        setPanelOpen(false);
        try {
          if (animRef.current.phase === "thinking") playPhase("idle");
        } catch (_) {
          /* ignore */
        }
      }, [playPhase]);

      // Esc 关闭面板（capture 阶段抢在 DSH 快捷键前）
      useEffect(() => {
        if (!panelOpen) return undefined;
        const onKey = (e) => {
          try {
            if (e.key === "Escape") {
              e.stopPropagation();
              setPanelOpen(false);
            }
          } catch (_) {
            /* ignore */
          }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      }, [panelOpen]);

      // =====================================================================
      // 拖动 + 位置保存
      // =====================================================================

      const queueSaveAppearance = useCallback((patch) => {
        pendingSaveRef.current = patch;
        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
        // 节流 500ms：连续拖动只在松手 500ms 后发一次局部保存
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = null;
          const body = pendingSaveRef.current;
          pendingSaveRef.current = null;
          if (!body) return;
          // 失败静默：位置不是关键数据，下次拖动/设置页保存会再同步
          apiPost("/api/settings", body, 15000).catch(() => {});
        }, 500);
      }, []);

      const handlePointerDown = (event) => {
        try {
          if (event.button !== undefined && event.button !== 0) return;
          const el = event.currentTarget;
          if (!el) return;
          try {
            el.setPointerCapture(event.pointerId);
          } catch (_) {
            /* 某些环境不支持捕获，后面 pointermove 仍会到 window 吗？不会，但拖动降级为不可用可接受 */
          }
          let rect = null;
          try {
            rect = anchorRef.current ? anchorRef.current.getBoundingClientRect() : null;
          } catch (_) {
            rect = null;
          }
          dragRef.current = {
            active: true,
            dragging: false,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            offX: rect ? event.clientX - rect.left : 0,
            offY: rect ? event.clientY - rect.top : 0,
            lastX: rect ? rect.left : 0,
            lastY: rect ? rect.top : 0,
          };
          suppressClickRef.current = false;
        } catch (e) {
          warn("pointerdown 异常：", errorText(e));
        }
      };

      const handlePointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag.active) return;
        try {
          const dx = event.clientX - drag.startX;
          const dy = event.clientY - drag.startY;
          if (!drag.dragging) {
            if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
            drag.dragging = true;
            setDragging(true);
            resetSway(); // 打断位移小动作时把水平偏移归零，避免松手后停在错位
            playPhase("drag"); // 拖动中暂停动画链（循环播放拖拽反馈）
          }
          const el = anchorRef.current;
          if (!el) return;
          const size = appearanceRef.current.size;
          const width = size;
          const height = (size * 9) / 16;
          const maxX = Math.max(0, (window.innerWidth || 1280) - width);
          const maxY = Math.max(0, (window.innerHeight || 800) - height);
          let x = event.clientX - drag.offX;
          let y = event.clientY - drag.offY;
          x = Math.min(Math.max(0, x), maxX);
          y = Math.min(Math.max(0, y), maxY);
          drag.lastX = x;
          drag.lastY = y;
          el.style.left = Math.round(x) + "px";
          el.style.top = Math.round(y) + "px";
          el.style.right = "auto";
          el.style.bottom = "auto";
        } catch (e) {
          warn("pointermove 异常：", errorText(e));
        }
      };

      const handlePointerUp = (event) => {
        const drag = dragRef.current;
        if (!drag.active) return;
        drag.active = false;
        try {
          const el = event.currentTarget;
          if (el && typeof el.hasPointerCapture === "function" && typeof el.releasePointerCapture === "function") {
            if (el.hasPointerCapture(drag.pointerId)) el.releasePointerCapture(drag.pointerId);
          }
        } catch (_) {
          /* ignore */
        }
        if (!drag.dragging) {
          drag.dragging = false;
          return;
        }
        drag.dragging = false;
        suppressClickRef.current = true;
        try {
          setDragging(false);
        } catch (_) {
          /* ignore */
        }
        try {
          const size = appearanceRef.current.size;
          const width = size;
          const height = (size * 9) / 16;
          const vw = window.innerWidth || 1280;
          const vh = window.innerHeight || 800;
          const x = drag.lastX;
          const y = drag.lastY;
          const leftSide = x + width / 2 < vw / 2;
          const topSide = y + height / 2 < vh / 2;
          const corner = (topSide ? "top-" : "bottom-") + (leftSide ? "left" : "right");
          const marginX = Math.round(Math.min(1000, Math.max(0, leftSide ? x : vw - (x + width))));
          const marginY = Math.round(Math.min(1000, Math.max(0, topSide ? y : vh - (y + height))));
          setAppearance(Object.assign({}, appearanceRef.current, { corner: corner, marginX: marginX, marginY: marginY }));
          queueSaveAppearance({ appearance: { corner: corner, marginX: marginX, marginY: marginY } });
          // 清掉拖动时写的内联坐标，交回 CSS 的 corner+margin 布局
          const anchor = anchorRef.current;
          if (anchor) {
            anchor.style.left = "";
            anchor.style.top = "";
            anchor.style.right = "";
            anchor.style.bottom = "";
          }
        } catch (e) {
          warn("保存拖动位置失败：", errorText(e));
        }
        playPhase("idle");
      };

      // 外观变化后清一次内联坐标（拖动结束时可能还有残留；尺寸变化时也顺手复位）
      useEffect(() => {
        const el = anchorRef.current;
        if (!el) return;
        el.style.left = "";
        el.style.top = "";
        el.style.right = "";
        el.style.bottom = "";
      }, [appearance.corner, appearance.marginX, appearance.marginY, appearance.size, appearance.enabled]);

      // =====================================================================
      // 点击 / 双击 / 键盘
      // =====================================================================

      const handlePetClick = () => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        if (clickTimerRef.current !== null) return; // 双击的第一次点击已经在等待
        clickTimerRef.current = window.setTimeout(() => {
          clickTimerRef.current = null;
          try {
            if (unreadRef.current > 0) {
              const msg = lastMsgRef.current || baselineMsgRef.current;
              if (msg && typeof msg.text === "string" && msg.text) {
                showBubbleRef.current({
                  text: msg.text,
                  source: isObject(msg.source) && msg.source.url ? msg.source : null,
                  kind: msg.kind,
                });
              }
              markRead();
              return;
            }
            playPhase("happy");
            showBubbleRef.current({ text: pick(CLICK_LINES) || "我在呢～" });
          } catch (e) {
            warn("单击处理失败：", errorText(e));
          }
        }, CLICK_DELAY_MS);
      };

      const handlePetDoubleClick = () => {
        if (clickTimerRef.current !== null) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        openPanel();
      };

      const handlePetKeyDown = (event) => {
        try {
          if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
            event.preventDefault();
            handlePetClick();
          }
        } catch (_) {
          /* ignore */
        }
      };

      // =====================================================================
      // 面板定位（宠物在右 → 面板在左；上方不够就往下压）
      // =====================================================================

      useEffect(() => {
        if (!panelOpen) return undefined;
        const compute = () => {
          try {
            const el = anchorRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const vw = window.innerWidth || 1280;
            const vh = window.innerHeight || 800;
            const PANEL_W = 340;
            const GAP = 12;
            const M = 10;
            const panelH = Math.max(220, Math.min(460, vh - M * 2));
            let left = rect.left + rect.width / 2 > vw / 2 ? rect.left - GAP - PANEL_W : rect.right + GAP;
            if (left + PANEL_W > vw - M) left = vw - M - PANEL_W;
            if (left < M) left = M;
            let top = rect.bottom - panelH;
            if (top < M) top = M;
            if (top + panelH > vh - M) top = vh - M - panelH;
            if (top < M) top = M;
            setPanelPos({ left: Math.round(left), top: Math.round(top), height: Math.round(panelH) });
          } catch (_) {
            /* 定位失败就用上一次的位置，不崩 */
          }
        };
        compute();
        window.addEventListener("resize", compute);
        let observer = null;
        try {
          if (typeof ResizeObserver !== "undefined" && anchorRef.current) {
            observer = new ResizeObserver(compute);
            observer.observe(anchorRef.current);
          }
        } catch (_) {
          observer = null;
        }
        return () => {
          window.removeEventListener("resize", compute);
          try {
            if (observer) observer.disconnect();
          } catch (_) {
            /* ignore */
          }
        };
      }, [panelOpen, appearance.corner, appearance.marginX, appearance.marginY, appearance.size]);

      // =====================================================================
      // 渲染
      // =====================================================================

      // 关掉桌宠：overlay 不渲染任何东西（设置页仍然可用）
      if (!appearance.enabled) return null;

      const name = persona.name || DEFAULT_CONFIG.persona.name;
      const ownerTitle = persona.ownerTitle || DEFAULT_CONFIG.persona.ownerTitle;
      const sizePx = appearance.size + "px";

      const overlayStyle = {
        "--wc-size": sizePx,
        "--wc-mx": appearance.marginX + "px",
        "--wc-my": appearance.marginY + "px",
        "--wc-font": fontStackOf(appearance.fontFamily),
      };

      const petStyle = {
        "--wc-shift": sway.x + "px",
        "--wc-flip": sway.flip ? "-1" : "1",
      };

      const fallbackNode = videoFailed
        ? iconFailed
          ? h("div", { key: "emoji", className: "wc-fallback wc-fallback-emoji", "aria-hidden": "true" }, "🐳")
          : h("img", {
              key: "icon",
              className: "wc-fallback",
              src: ICON_URL,
              alt: "",
              draggable: false,
              onError: () => {
                try {
                  setIconFailed(true);
                } catch (_) {
                  /* ignore */
                }
              },
            })
        : null;

      return h(
        "div",
        {
          className: "wc-overlay",
          "data-wc-dark": dark ? "1" : "0",
          "data-font": appearance.fontFamily,
          style: overlayStyle,
        },
        h(
          "div",
          { ref: anchorRef, className: "wc-anchor", "data-corner": appearance.corner },
          h(
            "div",
            {
              className: "wc-petwrap" + (dragging ? " is-dragging" : ""),
              style: petStyle,
              role: "button",
              tabIndex: 0,
              title: name + "：单击互动，双击打开对话",
              "aria-label": name + "桌宠，单击互动，双击打开鲸聊对话面板",
              onPointerDown: handlePointerDown,
              onPointerMove: handlePointerMove,
              onPointerUp: handlePointerUp,
              onPointerCancel: handlePointerUp,
              onClick: handlePetClick,
              onDoubleClick: handlePetDoubleClick,
              onKeyDown: handlePetKeyDown,
              onContextMenu: (e) => {
                // 只吃掉宠物上的默认右键，不进入 DSH 菜单（SPEC §6.1）
                try {
                  e.preventDefault();
                } catch (_) {
                  /* ignore */
                }
              },
            },
            videoFailed
              ? null
              : h("video", {
                  key: "video",
                  ref: videoRef,
                  className: "wc-video",
                  src: videoSrc(anim.name),
                  muted: true,
                  autoPlay: true,
                  playsInline: true,
                  preload: "auto",
                  loop: anim.phase === "thinking" || anim.phase === "drag",
                  "aria-hidden": "true",
                  onEnded: handleEnded,
                  onError: () => {
                    warn("动画素材加载失败，回退为静态图标：" + anim.name);
                    try {
                      setVideoFailed(true);
                    } catch (_) {
                      /* ignore */
                    }
                  },
                }),
            fallbackNode,
          ),
          h(
            "button",
            {
              type: "button",
              className: "wc-chatbtn",
              title: "打开对话面板",
              "aria-label": "打开" + name + "的对话面板",
              onClick: (e) => {
                try {
                  e.stopPropagation();
                } catch (_) {
                  /* ignore */
                }
                openPanel();
              },
              onPointerDown: (e) => {
                try {
                  e.stopPropagation();
                } catch (_) {
                  /* ignore */
                }
              },
            },
            "💬",
          ),
          unread > 0
            ? h(
                "button",
                {
                  type: "button",
                  className: "wc-badge",
                  title: "有 " + unread + " 条新消息，点开看看",
                  "aria-label": "有 " + unread + " 条新消息，打开对话面板",
                  onClick: (e) => {
                    try {
                      e.stopPropagation();
                    } catch (_) {
                      /* ignore */
                    }
                    openPanel();
                  },
                  onPointerDown: (e) => {
                    try {
                      e.stopPropagation();
                    } catch (_) {
                      /* ignore */
                    }
                  },
                },
                unread > 99 ? "99+" : String(unread),
              )
            : null,
          failStreak >= WARN_AFTER_FAILS
            ? h("div", { className: "wc-warn", title: "和鲸聊后台的连接不太顺畅，正在重试…", "aria-hidden": "true" })
            : null,
          bubble
            ? h(
                "div",
                {
                  className: "wc-bubble is-on",
                  role: "status",
                  "aria-live": "polite",
                  onClick: openPanel,
                },
                h("span", { className: "wc-bubble-text" }, bubble.text),
                bubble.source
                  ? h(
                      "a",
                      {
                        className: "wc-bubble-src",
                        href: bubble.source.url,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        title: bubble.source.url,
                        onClick: (e) => {
                          try {
                            e.stopPropagation();
                          } catch (_) {
                            /* ignore */
                          }
                        },
                      },
                      "来源：" + (bubble.source.name || "网页"),
                    )
                  : null,
              )
            : null,
        ),
        panelOpen
          ? h(ChatPanel, {
              key: "panel",
              position: panelPos,
              name: name,
              ownerTitle: ownerTitle,
              onClose: closePanel,
              onThinking: () => playPhase("thinking"),
              onTalk: (text) => {
                playPhase("talk");
                if (text) showBubbleRef.current({ text: text });
              },
              onWhisper: (item) => {
                playPhase("talk");
                if (item && item.text) {
                  showBubbleRef.current({
                    text: item.text,
                    source: isObject(item.source) && item.source.url ? item.source : null,
                    kind: "whisper",
                  });
                }
              },
              onFailure: () => playPhase("idle"),
            })
          : null,
      );
    }

    // =========================================================================
    // 对话面板
    // =========================================================================

    function normalizeHistory(list) {
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const raw of list) {
        if (!isObject(raw)) continue;
        const content = typeof raw.content === "string" ? raw.content : "";
        if (!content) continue;
        out.push({
          role: raw.role === "user" ? "user" : "assistant",
          content: content,
          ts: Number(raw.ts) || 0,
          kind: raw.kind,
        });
      }
      return out;
    }

    function ChatPanel(props) {
      const { position, name, ownerTitle, onClose, onThinking, onTalk, onWhisper, onFailure } = props;

      const [messages, setMessages] = useState([]);
      const [loading, setLoading] = useState(true);
      const [loadErr, setLoadErr] = useState("");
      const [input, setInput] = useState("");
      const [sending, setSending] = useState(false);
      const [sendingErr, setSendingErr] = useState("");
      const [model, setModel] = useState("");
      const [confirmClear, setConfirmClear] = useState(false);
      const [busy, setBusy] = useState("");
      const [notice, setNotice] = useState("");

      const listRef = useRef(null);
      const inputRef = useRef(null);
      const aliveRef = useRef(true);
      const sendingRef = useRef(false);
      const mountedRef = useRef(true);

      useEffect(() => {
        mountedRef.current = true;
        aliveRef.current = true;
        return () => {
          mountedRef.current = false;
          aliveRef.current = false;
        };
      }, []);

      // 打开时拉历史 + 当前模型；任何失败都只是一行中文提示，不挡输入
      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const results = await Promise.allSettled([apiGet("/api/history?limit=50", 20000), apiGet("/api/status", 15000)]);
            if (cancelled) return;
            const history = results[0];
            const status = results[1];
            if (history.status === "fulfilled") {
              setMessages(normalizeHistory(history.value.messages));
            } else {
              setLoadErr("读取对话记录失败：" + errorText(history.reason));
            }
            if (status.status === "fulfilled") {
              const runtime = status.value.runtime;
              const m = runtime && isObject(runtime.chatModel) ? runtime.chatModel : runtime && runtime.model;
              setModel(modelLabel(m));
            }
          } finally {
            if (!cancelled) setLoading(false);
          }
        })();
        const focusTimer = window.setTimeout(() => {
          try {
            if (inputRef.current) inputRef.current.focus();
          } catch (_) {
            /* ignore */
          }
        }, 60);
        return () => {
          cancelled = true;
          window.clearTimeout(focusTimer);
        };
      }, []);

      // 新消息 / 正在想 → 滚到底
      useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        try {
          el.scrollTop = el.scrollHeight;
        } catch (_) {
          /* ignore */
        }
      }, [messages, sending]);

      const send = async () => {
        const text = input.trim();
        if (!text || sendingRef.current) return;
        if (text.length > 8000) {
          setSendingErr("太长了：一次最多 8000 字。");
          return;
        }
        sendingRef.current = true;
        setSending(true);
        setSendingErr("");
        setNotice("");
        setConfirmClear(false);
        setMessages((prev) => prev.concat([{ role: "user", content: text, ts: Date.now() }]));
        setInput("");
        try {
          if (onThinking) onThinking();
        } catch (_) {
          /* ignore */
        }
        try {
          const data = await apiPost("/api/chat", { text: text }, 70000);
          if (!aliveRef.current) return;
          const reply = isObject(data.reply) ? data.reply : {};
          const replyText =
            (typeof reply.text === "string" && reply.text) || (typeof reply.content === "string" && reply.content) || "";
          setMessages((prev) =>
            prev.concat([{ role: "assistant", content: replyText || "（这次她没说出话来…）", ts: Number(reply.ts) || Date.now() }]),
          );
          if (data.model) setModel(modelLabel(data.model));
          if (onTalk) onTalk(replyText);
        } catch (e) {
          if (!aliveRef.current) return;
          const reason = errorText(e);
          setSendingErr("发送失败：" + reason);
          setMessages((prev) => prev.concat([{ role: "error", content: reason, ts: Date.now() }]));
          // 保留用户刚打的字（若用户已经在输入框里重新输入了，就别覆盖）
          setInput((prev) => (prev === "" ? text : prev));
          if (onFailure) onFailure();
        } finally {
          sendingRef.current = false;
          if (aliveRef.current) setSending(false);
        }
      };

      const whisper = async () => {
        if (busy || sending) return;
        setBusy("whisper");
        setSendingErr("");
        setNotice("");
        setConfirmClear(false);
        try {
          const data = await apiPost("/api/whisper", {}, 70000);
          if (!aliveRef.current) return;
          const item = isObject(data.item) ? data.item : null;
          if (item && typeof item.text === "string" && item.text) {
            setMessages((prev) => prev.concat([{ role: "note", content: item.text, ts: Date.now() }]));
            if (onWhisper) onWhisper(item);
          } else {
            setSendingErr("她这次没想出说什么，再点一次试试。");
          }
        } catch (e) {
          if (aliveRef.current) setSendingErr("换一句失败：" + errorText(e));
        } finally {
          if (aliveRef.current) setBusy("");
        }
      };

      const clearHistory = async () => {
        if (busy) return;
        setBusy("clear");
        setSendingErr("");
        setNotice("");
        try {
          const data = await apiPost("/api/history/clear", {}, 20000);
          if (!aliveRef.current) return;
          setMessages([]);
          setConfirmClear(false);
          setNotice("已清空 " + (data.cleared === undefined ? "" : data.cleared) + " 条对话记忆。");
        } catch (e) {
          if (aliveRef.current) setSendingErr("清空失败：" + errorText(e));
        } finally {
          if (aliveRef.current) setBusy("");
        }
      };

      // 输入框高度随内容 1–4 行自适应；由 DOM 直接改 style（不每帧 setState）
      useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        try {
          el.style.height = "auto";
          el.style.height = Math.min(96, Math.max(34, el.scrollHeight)) + "px";
        } catch (_) {
          /* ignore */
        }
      }, [input]);

      const onTextChange = (event) => {
        setInput(event.target.value);
      };

      // 面板根节点只处理 Esc（textarea 里的 Enter 由下面的专用处理器负责，
      // 否则在「发送/清空」按钮上按 Enter 会被面板误当成发送）。
      const onPanelKeyDown = (event) => {
        try {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        } catch (e) {
          warn("面板按键处理失败：", errorText(e));
        }
      };

      const onTextareaKeyDown = (event) => {
        try {
          if (event.key !== "Enter" || event.shiftKey) return;
          const native = event.nativeEvent || {};
          if (native.isComposing || event.keyCode === 229) return; // 输入法组词中的回车不算发送
          event.preventDefault();
          send();
        } catch (e) {
          warn("输入框按键处理失败：", errorText(e));
        }
      };

      const renderMessage = (m, index) => {
        const key = "m" + index;
        if (m.role === "user") return h("div", { key: key, className: "wc-msg wc-msg-user" }, h("div", { className: "wc-msg-body" }, m.content));
        if (m.role === "error") return h("div", { key: key, className: "wc-msg wc-msg-error" }, h("div", { className: "wc-msg-body" }, m.content));
        if (m.role === "note") return h("div", { key: key, className: "wc-msg wc-msg-note" }, h("div", { className: "wc-msg-body" }, m.content));
        return h(
          "div",
          { key: key, className: "wc-msg wc-msg-assistant" },
          h("div", { className: "wc-msg-body" }, m.content),
        );
      };

      const messagesOrEmpty =
        messages.length > 0
          ? messages.map(renderMessage)
          : !loading && !loadErr
            ? h(
                "div",
                { className: "wc-empty" },
                h("div", { className: "wc-empty-emoji", "aria-hidden": "true" }, "🐳"),
                h("div", null, "在呢，" + ownerTitle + "想聊点什么？"),
                h("div", { className: "wc-empty-sub" }, "Enter 发送，Shift+Enter 换行"),
              )
            : null;

      const statusText = model ? "当前模型：" + model : "当前模型：跟随当前对话";

      return h(
        "div",
        {
          className: "wc-panel",
          style: { left: position.left + "px", top: position.top + "px", height: position.height + "px" },
          role: "dialog",
          "aria-label": name + " · 鲸聊",
          onKeyDown: onPanelKeyDown,
        },
        h(
          "div",
          { className: "wc-panel-head" },
          h("div", { className: "wc-panel-title" }, name + " · 鲸聊"),
          h(
            "button",
            {
              type: "button",
              className: "wc-iconbtn",
              title: "关闭对话面板（Esc）",
              "aria-label": "关闭对话面板",
              onClick: onClose,
            },
            "×",
          ),
        ),
        h(
          "div",
          { className: "wc-msglist", ref: listRef, role: "log", "aria-live": "polite", "aria-label": "对话记录" },
          loading ? h("div", { className: "wc-typing" }, "读取对话记录…") : null,
          loadErr ? h("div", { className: "wc-msg wc-msg-error" }, h("div", { className: "wc-msg-body" }, loadErr)) : null,
          messagesOrEmpty,
          sending
            ? h(
                "div",
                { className: "wc-msg wc-msg-assistant" },
                h(
                  "div",
                  { className: "wc-typing" },
                  h("span", { "aria-hidden": "true" }),
                  h("span", { "aria-hidden": "true" }),
                  h("span", { "aria-hidden": "true" }),
                  h("em", null, "正在想…"),
                ),
              )
            : null,
        ),
        sendingErr ? h("div", { className: "wc-panel-err", role: "alert" }, sendingErr) : null,
        notice ? h("div", { className: "wc-panel-notice", role: "status" }, notice) : null,
        h(
          "div",
          { className: "wc-composer" },
          h("textarea", {
            ref: inputRef,
            className: "wc-textarea",
            rows: 1,
            value: input,
            maxLength: 8000,
            placeholder: "和" + name + "说点什么…",
            "aria-label": "输入消息",
            onChange: onTextChange,
            onKeyDown: onTextareaKeyDown,
          }),
          h(
            "button",
            {
              type: "button",
              className: "wc-send",
              disabled: sending || input.trim() === "",
              title: "发送（Enter）",
              "aria-label": "发送消息",
              onClick: send,
            },
            "发送",
          ),
        ),
        h(
          "div",
          { className: "wc-panel-foot" },
          confirmClear
            ? h(
                "span",
                { className: "wc-confirm" },
                h("span", null, "确定清空全部对话记忆？"),
                h("button", { type: "button", className: "wc-linkbtn", onClick: clearHistory, disabled: !!busy || sending }, "确定清空"),
                h(
                  "button",
                  {
                    type: "button",
                    className: "wc-linkbtn",
                    onClick: () => setConfirmClear(false),
                    disabled: !!busy,
                  },
                  "取消",
                ),
              )
            : h("span", null, statusText),
          h("span", { className: "wc-foot-grow" }),
          confirmClear
            ? null
            : [
                h(
                  "button",
                  {
                    key: "whisper",
                    type: "button",
                    className: "wc-linkbtn",
                    onClick: whisper,
                    disabled: !!busy || sending,
                    title: "让她随机说一句",
                  },
                  busy === "whisper" ? "想呢…" : "换一句",
                ),
                h(
                  "button",
                  {
                    key: "clear",
                    type: "button",
                    className: "wc-linkbtn",
                    onClick: () => {
                      setConfirmClear(true);
                      setSendingErr("");
                      setNotice("");
                    },
                    disabled: !!busy || sending,
                    title: "清空对话记忆",
                  },
                  "清空",
                ),
              ],
        ),
      );
    }

    // =========================================================================
    // 设置页（settings.section）
    // =========================================================================

    /** 数字输入控件：内部保存文本，允许用户打 "0." / 清空等中间态；不合法只回填 undefined。 */
    function NumberField(props) {
      const { value, onCommit, min, max, step, invalid, ariaLabel } = props;
      const [text, setText] = useState(value === undefined || value === null ? "" : String(value));
      const lastRef = useRef(value);
      useEffect(() => {
        if (value !== lastRef.current) {
          lastRef.current = value;
          setText(value === undefined || value === null ? "" : String(value));
        }
      }, [value]);
      return h("input", {
        type: "number",
        className: "wc-s-input is-num" + (invalid ? " is-bad" : ""),
        value: text,
        min: min,
        max: max,
        step: step === undefined ? "any" : step,
        inputMode: "decimal",
        "aria-label": ariaLabel || undefined,
        onChange: (event) => {
          const raw = event.target.value;
          setText(raw);
          if (raw.trim() === "") {
            lastRef.current = undefined;
            onCommit(undefined);
            return;
          }
          const n = Number(raw);
          if (Number.isFinite(n)) {
            lastRef.current = n;
            onCommit(n);
          }
        },
      });
    }

    function SGroup(props) {
      return h(
        "section",
        { className: "wc-s-group" },
        h("h4", { className: "wc-s-group-title" }, props.title),
        props.desc ? h("p", { className: "wc-s-group-desc" }, props.desc) : null,
        h("div", { className: "wc-s-rows" }, props.children),
      );
    }

    function SRow(props) {
      return h(
        "div",
        { className: "wc-s-row" + (props.wide ? " is-wide" : "") },
        h(
          "div",
          { className: "wc-s-row-label" },
          h("div", { className: "wc-s-label" }, props.label),
          props.hint ? h("div", { className: "wc-s-hint" }, props.hint) : null,
        ),
        h(
          "div",
          { className: "wc-s-control" },
          props.children,
          props.problem ? h("div", { className: "wc-s-err", role: "alert" }, props.problem) : null,
        ),
      );
    }

    function SwitchRow(props) {
      return h(
        "label",
        { className: "wc-s-row" },
        h(
          "div",
          { className: "wc-s-row-label" },
          h("div", { className: "wc-s-label" }, props.label),
          props.hint ? h("div", { className: "wc-s-hint" }, props.hint) : null,
        ),
        h(
          "div",
          { className: "wc-s-control wc-s-control-row" },
          h("input", {
            type: "checkbox",
            className: "wc-s-check",
            checked: !!props.value,
            disabled: !!props.disabled,
            "aria-label": props.label,
            onChange: (e) => props.onChange(!!e.target.checked),
          }),
        ),
      );
    }

    /** 来源清单：每行 `名称 | URL | 类型`；宽容解析，逐行报错。 */
    function sourcesToText(list) {
      if (!Array.isArray(list)) return "";
      const lines = [];
      for (const item of list) {
        if (!isObject(item)) continue;
        const name = typeof item.name === "string" ? item.name : "";
        const url = typeof item.url === "string" ? item.url : "";
        const type = typeof item.type === "string" ? item.type : "";
        let line = name + " | " + url;
        if (type) line += " | " + type;
        lines.push(line);
      }
      return lines.join("\n");
    }

    function parseSourcesText(text) {
      const items = [];
      const errors = [];
      const lines = String(text === undefined || text === null ? "" : text).split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (line === "") continue;
        if (line.charAt(0) === "#") continue; // 允许注释行，方便备注
        const parts = line.split("|").map((s) => s.trim());
        const name = parts[0] || "";
        const url = parts[1] || "";
        const typeRaw = (parts[2] || "").toLowerCase();
        if (!name) {
          errors.push("第 " + (i + 1) + " 行缺少名称");
          continue;
        }
        if (!/^https?:\/\/\S+$/i.test(url)) {
          errors.push("第 " + (i + 1) + " 行的链接不是 http/https");
          continue;
        }
        const type = typeRaw === "" ? "auto" : typeRaw;
        if (SOURCE_TYPES.indexOf(type) < 0) {
          errors.push("第 " + (i + 1) + " 行的类型只能是 auto / json / rss / html");
          continue;
        }
        items.push({ name: name, url: url, type: type });
      }
      if (items.length > 30) errors.push("来源最多 30 项（现在 " + items.length + " 项）");
      return { items: items, errors: errors };
    }

    /** 整份配置校验：返回 { fields: {path: 中文原因}, lines: [来源行错误] }。 */
    function validateConfig(cfg, sourceLineErrors) {
      const fields = {};
      const c = isObject(cfg) ? cfg : {};
      const p = isObject(c.persona) ? c.persona : {};
      const chat = isObject(c.chat) ? c.chat : {};
      const app = isObject(c.appearance) ? c.appearance : {};
      const roam = isObject(c.roam) ? c.roam : {};
      const quiet = isObject(roam.quiet) ? roam.quiet : {};

      if (textLength(p.name) < 1 || textLength(p.name) > 20) fields["persona.name"] = "名字要 1–20 个字";
      if (textLength(p.ownerTitle) < 1 || textLength(p.ownerTitle) > 20) fields["persona.ownerTitle"] = "称呼要 1–20 个字";
      if (textLength(p.selfClaim) < 1 || textLength(p.selfClaim) > 10) fields["persona.selfClaim"] = "自称要 1–10 个字";
      if (textLength(p.text) > 20000) fields["persona.text"] = "人设正文最多 20000 字（现在 " + textLength(p.text) + " 字）";

      if (!isNum(chat.memoryRounds) || !Number.isInteger(chat.memoryRounds) || chat.memoryRounds < 0 || chat.memoryRounds > 50) {
        fields["chat.memoryRounds"] = "记忆轮数要填 0–50 的整数";
      }
      if (!isNum(chat.temperature) || chat.temperature < 0 || chat.temperature > 2) {
        fields["chat.temperature"] = "温度要填 0–2 之间的数";
      }
      const provider = typeof chat.provider === "string" ? chat.provider.trim() : "";
      const model = typeof chat.model === "string" ? chat.model.trim() : "";
      if ((provider === "") !== (model === "")) {
        fields["chat.provider"] = "服务商和模型要么都填，要么都留空（留空 = 跟随当前对话）";
      }

      if (!isNum(app.size) || app.size < 160 || app.size > 640) fields["appearance.size"] = "大小要在 160–640 之间";
      if (!isNum(app.marginX) || app.marginX < 0 || app.marginX > 1000) fields["appearance.marginX"] = "边距 X 要在 0–1000 之间";
      if (!isNum(app.marginY) || app.marginY < 0 || app.marginY > 1000) fields["appearance.marginY"] = "边距 Y 要在 0–1000 之间";
      if (!isNum(app.bubbleSeconds) || app.bubbleSeconds < 4 || app.bubbleSeconds > 120) {
        fields["appearance.bubbleSeconds"] = "气泡停留要 4–120 秒";
      }
      if (CORNERS.indexOf(app.corner) < 0) fields["appearance.corner"] = "角落取值不合法";
      if (app.fontFamily !== "candy" && app.fontFamily !== "system") fields["appearance.fontFamily"] = "字体只能是 candy 或 system";

      if (!isNum(roam.intervalMin) || roam.intervalMin < 5 || roam.intervalMin > 1440) {
        fields["roam.intervalMin"] = "间隔要 5–1440 分钟";
      }
      if (!isNum(roam.maxPerDay) || !Number.isInteger(roam.maxPerDay) || roam.maxPerDay < 0 || roam.maxPerDay > 24) {
        fields["roam.maxPerDay"] = "每天上限要 0–24 的整数";
      }
      if (!isNum(roam.charLimit) || roam.charLimit < 500 || roam.charLimit > 8000) {
        fields["roam.charLimit"] = "正文上限要 500–8000";
      }
      if (quiet.enabled) {
        if (!TIME_RE.test(String(quiet.start || ""))) fields["roam.quiet.start"] = "开始时间要写成 HH:MM（例如 23:00）";
        if (!TIME_RE.test(String(quiet.end || ""))) fields["roam.quiet.end"] = "结束时间要写成 HH:MM（例如 08:00）";
      }

      const lines = Array.isArray(sourceLineErrors) ? sourceLineErrors : [];
      return { fields: fields, lines: lines };
    }

    function countProblems(problems) {
      if (!problems) return 0;
      return Object.keys(problems.fields || {}).length + (problems.lines ? problems.lines.length : 0);
    }

    function renderPathsText(paths) {
      if (!paths) return "（宿主没有返回路径信息）";
      if (typeof paths === "string") return paths;
      if (!isObject(paths)) return String(paths);
      const keys = Object.keys(paths);
      if (keys.length === 0) return "（空）";
      return keys
        .map((key) => {
          const value = paths[key];
          if (isObject(value)) return key + "：" + JSON.stringify(value);
          return key + "：" + String(value);
        })
        .join("\n");
    }

    function WhaleChatSettings() {
      ensureStyle();

      const [cfg, setCfg] = useState(null);
      const [savedJson, setSavedJson] = useState("");
      const [runtime, setRuntime] = useState(null);
      const [paths, setPaths] = useState(null);
      const [sourcesText, setSourcesText] = useState("");
      const [sourceErrors, setSourceErrors] = useState([]);
      const [sourcesTouched, setSourcesTouched] = useState(false);
      const [loadErr, setLoadErr] = useState("");
      const [err, setErr] = useState("");
      const [out, setOut] = useState("");
      const [busy, setBusy] = useState("");
      const [confirmClear, setConfirmClear] = useState(false);
      const [reloadAsk, setReloadAsk] = useState(false);
      const mountedRef = useRef(true);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      const load = useCallback(async () => {
        setLoadErr("");
        setErr("");
        try {
          const data = await apiGet("/api/settings", 20000);
          if (!mountedRef.current) return;
          const merged = mergeDeep(DEFAULT_CONFIG, isObject(data.config) ? data.config : {});
          setCfg(merged);
          setSavedJson(JSON.stringify(merged));
          setRuntime(isObject(data.runtime) ? data.runtime : null);
          setPaths(data.paths === undefined ? null : data.paths);
          setSourcesText(sourcesToText(merged.roam && merged.roam.sources));
          setSourceErrors([]);
          setSourcesTouched(false);
          setReloadAsk(false);
          setConfirmClear(false);
        } catch (e) {
          if (mountedRef.current) setLoadErr("读取配置失败：" + errorText(e));
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const refreshRuntime = useCallback(async () => {
        try {
          const data = await apiGet("/api/status", 15000);
          if (mountedRef.current && isObject(data.runtime)) setRuntime(data.runtime);
        } catch (_) {
          /* 状态刷新失败不影响主流程 */
        }
      }, []);

      const setPath = useCallback((path, value) => {
        setCfg((current) => {
          const next = mergeDeep({}, current || {});
          let cursor = next;
          for (let i = 0; i < path.length - 1; i += 1) {
            const key = path[i];
            if (!isObject(cursor[key])) cursor[key] = {};
            cursor = cursor[key];
          }
          cursor[path[path.length - 1]] = value;
          return next;
        });
      }, []);

      const handleSourcesChange = (text) => {
        setSourcesText(text);
        setSourcesTouched(true);
        const parsed = parseSourcesText(text);
        setSourceErrors(parsed.errors);
        setCfg((current) => {
          const next = mergeDeep({}, current || {});
          if (!isObject(next.roam)) next.roam = {};
          next.roam.sources = parsed.items;
          return next;
        });
      };

      const problems = useMemo(
        () => (cfg ? validateConfig(cfg, sourceErrors) : { fields: {}, lines: [] }),
        [cfg, sourceErrors],
      );
      const problemCount = countProblems(problems);
      const dirty = !!cfg && (JSON.stringify(cfg) !== savedJson || sourcesTouched);

      const save = async () => {
        if (!cfg) return;
        if (problemCount > 0) {
          setErr("有 " + problemCount + " 处内容需要先改好（看下面红字）才能保存。");
          return;
        }
        setBusy("save");
        setErr("");
        setOut("");
        try {
          const data = await apiPost("/api/settings", { config: cfg }, 30000);
          if (!mountedRef.current) return;
          const merged = mergeDeep(DEFAULT_CONFIG, isObject(data.config) ? data.config : cfg);
          setCfg(merged);
          setSavedJson(JSON.stringify(merged));
          setRuntime(isObject(data.runtime) ? data.runtime : runtime);
          if (data.paths !== undefined) setPaths(data.paths);
          setSourcesTouched(false);
          setSourceErrors([]);
          setSourcesText(sourcesToText(merged.roam && merged.roam.sources));
          const warnings = Array.isArray(data.warnings) ? data.warnings : data.warning ? [String(data.warning)] : [];
          setOut("✓ 已保存。" + (warnings.length ? "\n⚠️ " + warnings.join("\n⚠️ ") : ""));
          // 通知同页的桌宠立即刷新外观/名字（不用等 60s 轮询）
          try {
            window.dispatchEvent(new CustomEvent("dsh-whale-chat:settings-changed"));
          } catch (_) {
            /* ignore */
          }
        } catch (e) {
          if (mountedRef.current) setErr("保存失败：" + errorText(e));
        } finally {
          if (mountedRef.current) setBusy("");
        }
      };

      const describeSkip = (skipped) => {
        if (skipped === undefined || skipped === null) return "这次先不逛";
        if (typeof skipped === "string") return skipped;
        if (isObject(skipped)) {
          if (typeof skipped.reason === "string" && skipped.reason) return skipped.reason;
          if (typeof skipped.error === "string" && skipped.error) return skipped.error;
          try {
            return JSON.stringify(skipped);
          } catch (_) {
            return "这次先不逛";
          }
        }
        return String(skipped);
      };

      const runRoam = async () => {
        if (busy) return;
        setBusy("roam");
        setErr("");
        setOut("…正在上网，最多等 60 秒（宿主抓完会告诉你）");
        const showSkipped = (skipped) => {
          const why = describeSkip(skipped);
          setOut("上一次还没回来：" + (why === "running" ? "稍等一下" : why));
        };
        try {
          const data = await apiPost("/api/roam", { force: true }, 75000);
          if (!mountedRef.current) return;
          // 宿主的失败/忙都是 HTTP 200 + ok:false，requestJson 会 reject；
          // 这里再兜一次：只有 ok===true 才允许出现「✓」。
          if (data.ok !== true) {
            setErr("上网失败：" + ((typeof data.error === "string" && data.error) || "这次没逛成"));
            return;
          }
          if (data.skipped !== undefined && data.skipped !== null) {
            showSkipped(data.skipped);
            return;
          }
          const item = isObject(data.item) ? data.item : null;
          if (item && typeof item.text === "string" && item.text) {
            const source = isObject(item.source) ? item.source : null;
            setOut("✓ 逛到啦：\n" + item.text + (source && source.name ? "\n\n来源：" + source.name + (source.url ? "\n" + source.url : "") : ""));
          } else {
            setOut("✓ 这次逛完了，但没带回新消息（宿主可能只更新了调度状态）。");
          }
          await refreshRuntime();
        } catch (e) {
          if (!mountedRef.current) return;
          const raw = e && e.data;
          // 忙：{ ok:false, skipped:'running', error } → 显示「上一次还没回来」而不是报错
          if (isObject(raw) && raw.skipped !== undefined && raw.skipped !== null) {
            showSkipped(raw.skipped);
          } else {
            // 失败：优先用宿主给的中文 error（requestJson 已把它放进 e.message）
            const reason = (isObject(raw) && typeof raw.error === "string" && raw.error) || errorText(e);
            setErr("上网失败：" + reason);
          }
        } finally {
          if (mountedRef.current) setBusy("");
        }
      };

      const runWhisper = async () => {
        if (busy) return;
        setBusy("whisper");
        setErr("");
        setOut("…正在让她随便说一句");
        try {
          const data = await apiPost("/api/whisper", {}, 70000);
          if (!mountedRef.current) return;
          const item = isObject(data.item) ? data.item : null;
          setOut(item && item.text ? "✓ 她说了：\n" + item.text : "她这次没说出什么，再试一次吧。");
          await refreshRuntime();
        } catch (e) {
          if (mountedRef.current) setErr("碎碎念失败：" + errorText(e));
        } finally {
          if (mountedRef.current) setBusy("");
        }
      };

      const runTestChat = async () => {
        if (busy) return;
        setBusy("test");
        setErr("");
        setOut("…正在测试对话（最多 60 秒）");
        try {
          const data = await apiPost("/api/chat", { text: "在吗？用一句话回答我就好" }, 75000);
          if (!mountedRef.current) return;
          const reply = isObject(data.reply) ? data.reply : {};
          const replyText = (typeof reply.text === "string" && reply.text) || (typeof reply.content === "string" && reply.content) || "";
          setOut(
            "✓ 对话可用：\n" +
              replyText +
              "\n\n模型：" +
              (modelLabel(data.model) || "（跟随当前对话）") +
              (data.memoryCount !== undefined ? "\n记忆条数：" + data.memoryCount : ""),
          );
          await refreshRuntime();
        } catch (e) {
          if (mountedRef.current) setErr("测试对话失败：" + errorText(e));
        } finally {
          if (mountedRef.current) setBusy("");
        }
      };

      const doClearHistory = async () => {
        if (busy) return;
        setBusy("clear");
        setErr("");
        try {
          const data = await apiPost("/api/history/clear", {}, 20000);
          if (!mountedRef.current) return;
          setOut("✓ 已清空 " + (data.cleared === undefined ? "" : data.cleared) + " 条对话记忆。");
          setConfirmClear(false);
          await refreshRuntime();
        } catch (e) {
          if (mountedRef.current) setErr("清空记忆失败：" + errorText(e));
        } finally {
          if (mountedRef.current) setBusy("");
        }
      };

      // ── 读取失败 / 读取中 ──────────────────────────────────────────────
      if (!cfg) {
        return h(
          "div",
          { className: "wc-s" },
          h("h3", { className: "wc-s-title" }, "鲸聊"),
          h(
            "p",
            { className: "wc-s-intro" },
            "一只会说话的鲸鱼桌宠：陪你聊天、有人设、会自己随机上网逛一圈，把见闻带回来告诉你。",
          ),
          h(
            "div",
            { className: "wc-s-out" },
            loadErr ? loadErr + "\n\n确认插件宿主侧已启动后，点「重新读取」重试。" : "读取中…",
          ),
          h(
            "div",
            { className: "wc-s-actions", style: { borderTop: "none", paddingTop: "0" } },
            h(
              "button",
              {
                type: "button",
                className: "wc-s-btn is-2",
                onClick: load,
                disabled: !!busy,
              },
              "重新读取",
            ),
          ),
        );
      }

      const app = isObject(cfg.appearance) ? cfg.appearance : {};
      const roam = isObject(cfg.roam) ? cfg.roam : {};
      const quiet = isObject(roam.quiet) ? roam.quiet : {};
      const chatCfg = isObject(cfg.chat) ? cfg.chat : {};
      const runtimeRoam = runtime && isObject(runtime.roam) ? runtime.roam : {};
      const currentModel = runtime && isObject(runtime.chatModel) ? runtime.chatModel : runtime && runtime.model;
      const dataDir =
        (paths && isObject(paths) && (paths.dataDir || paths.dir || paths.data)) ||
        (runtime && runtime.dataDir) ||
        "—";

      const kvPairs = [
        ["当前对话模型", modelLabel(currentModel) || "（未配置）"],
        ["今日已逛次数", String(runtimeRoam.todayCount === undefined ? 0 : runtimeRoam.todayCount) + " / " + String(runtimeRoam.maxPerDay === undefined ? roam.maxPerDay : runtimeRoam.maxPerDay)],
        ["上次上网", formatWhen(runtimeRoam.lastAt)],
        ["下次上网", formatWhen(runtimeRoam.nextAt)],
        ["上次来源", runtimeRoam.lastSource || "—"],
        ["最近一次错误", runtimeRoam.lastError || "—"],
        ["记忆条数", String(runtime && runtime.memoryCount !== undefined ? runtime.memoryCount : "—")],
        ["未读主动消息", String(runtime && runtime.unread !== undefined ? runtime.unread : "—")],
        ["数据目录", dataDir],
      ];

      const kvNodes = [];
      for (let i = 0; i < kvPairs.length; i += 1) {
        kvNodes.push(h("dt", { key: "k" + i }, kvPairs[i][0]));
        kvNodes.push(h("dd", { key: "v" + i }, kvPairs[i][1]));
      }

      const textInput = (value, onChange, opts) =>
        h(
          "input",
          Object.assign(
            {
              className: "wc-s-input",
              value: value === undefined || value === null ? "" : String(value),
              onChange: (e) => onChange(e.target.value),
            },
            opts || {},
          ),
        );

      const sourcesProblem =
        problems.lines && problems.lines.length
          ? problems.lines.join("\n")
          : undefined;

      return h(
        "div",
        { className: "wc-s" },
        h("h3", { className: "wc-s-title" }, "鲸聊"),
        h(
          "p",
          { className: "wc-s-intro" },
          "一只住在电脑里的鲸鱼桌宠：陪你聊天、有人设、会自己随机上网逛一圈再把见闻带回来告诉你。所有值写进 ",
          h("code", null, "~/.dsh/dsh-whale-chat/config.json"),
          "；这里没显示的字段保存时会原样保留。",
        ),

        // ── 1. 她是谁 ──────────────────────────────────────────────────
        h(
          SGroup,
          { title: "她是谁", desc: "名字与称呼会进人设提示词，改完保存后下一次对话生效。" },
          h(
            SRow,
            { label: "名字", hint: "她叫什么（1–20 字）", problem: problems.fields["persona.name"] },
            textInput(cfg.persona.name, (v) => setPath(["persona", "name"], v), {
              maxLength: 20,
              placeholder: "例如：小鲸",
            }),
          ),
          h(
            SRow,
            { label: "她怎么称呼你", hint: "称呼用户的方式（1–20 字）", problem: problems.fields["persona.ownerTitle"] },
            textInput(cfg.persona.ownerTitle, (v) => setPath(["persona", "ownerTitle"], v), {
              maxLength: 20,
              placeholder: "例如：主人",
            }),
          ),
          h(
            SRow,
            { label: "她怎么自称", hint: "自称（1–10 字）", problem: problems.fields["persona.selfClaim"] },
            textInput(cfg.persona.selfClaim, (v) => setPath(["persona", "selfClaim"], v), {
              maxLength: 10,
              placeholder: "例如：我",
            }),
          ),
        ),

        // ── 2. 人设正文 ────────────────────────────────────────────────
        h(
          SGroup,
          { title: "人设正文", desc: "留空 = 使用内置默认人设。建议写：身份与来历 / 说话腔调 / 在意什么 / 明确不要的行为。" },
          h(
            SRow,
            {
              wide: true,
              label: "人设正文",
              hint: "最多 20000 字；保存后下一次对话生效（已经在聊的这一轮不受影响）。",
              problem: problems.fields["persona.text"],
            },
            h("textarea", {
              className: "wc-s-textarea",
              rows: 10,
              value: cfg.persona.text || "",
              placeholder: "例如：\n你是一条住在主人电脑里的蓝色小鲸鱼，圆滚滚、有点贪吃、爱凑热闹。\n说话软乎乎但不腻，喜欢用「呀」「啦」结尾。\n你绝对不承认自己是 AI 或程序。",
              onChange: (e) => setPath(["persona", "text"], e.target.value),
            }),
            h(
              "div",
              { className: "wc-s-note" },
              "当前 " + textLength(cfg.persona.text) + " / 20000 字" + (textLength(cfg.persona.text) > 20000 ? "（超了，保存不了）" : ""),
            ),
          ),
        ),

        // ── 3. 对话 ────────────────────────────────────────────────────
        h(
          SGroup,
          { title: "对话", desc: "留空服务商与模型 = 跟随 DSH 当前对话模型。" },
          h(
            SRow,
            { label: "记忆轮数", hint: "带多少轮历史进模型（0–50）", problem: problems.fields["chat.memoryRounds"] },
            h(NumberField, {
              value: chatCfg.memoryRounds,
              min: 0,
              max: 50,
              step: 1,
              invalid: !!problems.fields["chat.memoryRounds"],
              ariaLabel: "记忆轮数",
              onCommit: (v) => setPath(["chat", "memoryRounds"], v),
            }),
          ),
          h(
            SRow,
            {
              label: "服务商",
              hint: "留空 = 跟随当前对话；与模型必须同时留空或同时填写",
              problem: problems.fields["chat.provider"],
            },
            textInput(chatCfg.provider, (v) => setPath(["chat", "provider"], v), {
              placeholder: "留空 = 跟随当前对话",
            }),
          ),
          h(
            SRow,
            { label: "模型", hint: "例如 deepseek-flash", problem: problems.fields["chat.model"] },
            textInput(chatCfg.model, (v) => setPath(["chat", "model"], v), {
              placeholder: "留空 = 跟随当前对话",
            }),
          ),
          h(
            SRow,
            { label: "温度", hint: "0–2，越大越放飞（默认 1）", problem: problems.fields["chat.temperature"] },
            h(NumberField, {
              value: chatCfg.temperature,
              min: 0,
              max: 2,
              step: 0.1,
              invalid: !!problems.fields["chat.temperature"],
              ariaLabel: "温度",
              onCommit: (v) => setPath(["chat", "temperature"], v),
            }),
          ),
        ),

        // ── 4. 上网逛逛 ────────────────────────────────────────────────
        h(
          SGroup,
          { title: "上网逛逛", desc: "她会按间隔随机挑一个来源看一眼，再用自己的口吻把见闻说给你听。" },
          h(SwitchRow, {
            label: "开启随机上网",
            hint: "关掉 = 她不再自己上网（手动「立即上网看看」仍可用）",
            value: roam.enabled !== false,
            onChange: (v) => setPath(["roam", "enabled"], v),
          }),
          h(
            SRow,
            { label: "间隔（分钟）", hint: "5–1440；实际间隔会在基础值上 ×0.75–1.25 随机抖动", problem: problems.fields["roam.intervalMin"] },
            h(NumberField, {
              value: roam.intervalMin,
              min: 5,
              max: 1440,
              step: 5,
              invalid: !!problems.fields["roam.intervalMin"],
              ariaLabel: "上网间隔分钟",
              onCommit: (v) => setPath(["roam", "intervalMin"], v),
            }),
          ),
          h(
            SRow,
            { label: "每天最多几次", hint: "0–24；0 = 今天不再主动逛", problem: problems.fields["roam.maxPerDay"] },
            h(NumberField, {
              value: roam.maxPerDay,
              min: 0,
              max: 24,
              step: 1,
              invalid: !!problems.fields["roam.maxPerDay"],
              ariaLabel: "每天最多上网次数",
              onCommit: (v) => setPath(["roam", "maxPerDay"], v),
            }),
          ),
          h(SwitchRow, {
            label: "安静时段",
            hint: "命中时段（可跨午夜）就顺延到时段结束后 1–3 分钟",
            value: quiet.enabled !== false,
            onChange: (v) => setPath(["roam", "quiet", "enabled"], v),
          }),
          h(
            SRow,
            {
              label: "安静时段起止",
              hint: "24 小时制 HH:MM；例如 23:00 到 08:00 表示跨午夜",
              problem: [problems.fields["roam.quiet.start"], problems.fields["roam.quiet.end"]].filter(Boolean).join("\n"),
            },
            h(
              "div",
              { className: "wc-s-inline" },
              textInput(quiet.start, (v) => setPath(["roam", "quiet", "start"], v), {
                className: "wc-s-input" + (problems.fields["roam.quiet.start"] ? " is-bad" : ""),
                placeholder: "23:00",
                maxLength: 5,
                style: { width: "86px", minWidth: "86px" },
                "aria-label": "安静时段开始时间",
              }),
              h("span", { className: "wc-s-hint", style: { marginTop: "0" } }, "到"),
              textInput(quiet.end, (v) => setPath(["roam", "quiet", "end"], v), {
                className: "wc-s-input" + (problems.fields["roam.quiet.end"] ? " is-bad" : ""),
                placeholder: "08:00",
                maxLength: 5,
                style: { width: "86px", minWidth: "86px" },
                "aria-label": "安静时段结束时间",
              }),
            ),
          ),
          h(
            SRow,
            { label: "正文上限（字）", hint: "500–8000；送进模型的网页正文上限", problem: problems.fields["roam.charLimit"] },
            h(NumberField, {
              value: roam.charLimit,
              min: 500,
              max: 8000,
              step: 100,
              invalid: !!problems.fields["roam.charLimit"],
              ariaLabel: "正文上限字数",
              onCommit: (v) => setPath(["roam", "charLimit"], v),
            }),
          ),
          h(SwitchRow, {
            label: "消息里带来源链接",
            hint: "气泡底部显示「来源：<名字>」，点开是新标签页",
            value: roam.includeLink !== false,
            onChange: (v) => setPath(["roam", "includeLink"], v),
          }),
          h(SwitchRow, {
            label: "抓取失败也告诉你",
            hint: "每天最多一条「我刚才想上网看看，结果没连上……」",
            value: roam.reportFailure !== false,
            onChange: (v) => setPath(["roam", "reportFailure"], v),
          }),
          h(SwitchRow, {
            label: "允许代理 fake-IP",
            hint: "如果你的代理/加速器用 fake-IP（把域名解析成 198.18.x.x），关掉这个会让她哪个网站都上不去；只放行这一段，其它内网/回环仍然拒绝",
            value: roam.allowFakeIp !== false,
            onChange: (v) => setPath(["roam", "allowFakeIp"], v),
          }),
          h(
            SRow,
            {
              wide: true,
              label: "来源清单",
              hint: "每行一条：名称 | URL | 类型。类型可留空（= auto）。支持 auto / json / rss / html；最多 30 项。以 # 开头的行是注释。",
              problem: sourcesProblem,
            },
            h("textarea", {
              className: "wc-s-textarea" + (sourcesProblem ? " is-bad" : ""),
              rows: 7,
              value: sourcesText,
              spellCheck: false,
              placeholder: "B 站热门 | https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all | json",
              onChange: (e) => handleSourcesChange(e.target.value),
            }),
            h(
              "div",
              { className: "wc-s-note" },
              "现在 " + (Array.isArray(roam.sources) ? roam.sources.length : 0) + " 个来源；清空清单她就没地方可逛了。",
            ),
          ),
        ),

        // ── 5. 外观 ────────────────────────────────────────────────────
        h(
          SGroup,
          { title: "外观", desc: "保存后桌宠立即生效；也可以直接拖动桌宠，位置会自动记住。" },
          h(SwitchRow, {
            label: "显示桌宠",
            hint: "关掉 = 不显示（设置页仍然可用）",
            value: app.enabled !== false,
            onChange: (v) => setPath(["appearance", "enabled"], v),
          }),
          h(
            SRow,
            { label: "大小", hint: "160–640 px（高度按 16:9 自动算）", problem: problems.fields["appearance.size"] },
            h(
              "div",
              { className: "wc-s-inline" },
              h("input", {
                type: "range",
                className: "wc-s-range",
                min: 160,
                max: 640,
                step: 10,
                value: isNum(app.size) ? app.size : 320,
                "aria-label": "桌宠大小滑块",
                onChange: (e) => setPath(["appearance", "size"], Number(e.target.value)),
              }),
              h(NumberField, {
                value: app.size,
                min: 160,
                max: 640,
                step: 10,
                invalid: !!problems.fields["appearance.size"],
                ariaLabel: "桌宠大小像素",
                onCommit: (v) => setPath(["appearance", "size"], v),
              }),
            ),
          ),
          h(
            SRow,
            { label: "角落", hint: "桌宠贴哪个角；拖动后会自动选最近的角", problem: problems.fields["appearance.corner"] },
            h(
              "select",
              {
                className: "wc-s-select" + (problems.fields["appearance.corner"] ? " is-bad" : ""),
                value: app.corner,
                "aria-label": "桌宠所在的角落",
                onChange: (e) => setPath(["appearance", "corner"], e.target.value),
              },
              CORNERS.map((corner) => h("option", { key: corner, value: corner }, CORNER_LABELS[corner])),
            ),
          ),
          h(
            SRow,
            { label: "边距 X / Y", hint: "距角落的像素（0–1000）", problem: [problems.fields["appearance.marginX"], problems.fields["appearance.marginY"]].filter(Boolean).join("\n") },
            h(
              "div",
              { className: "wc-s-inline" },
              h(NumberField, {
                value: app.marginX,
                min: 0,
                max: 1000,
                step: 4,
                invalid: !!problems.fields["appearance.marginX"],
                ariaLabel: "水平边距",
                onCommit: (v) => setPath(["appearance", "marginX"], v),
              }),
              h(NumberField, {
                value: app.marginY,
                min: 0,
                max: 1000,
                step: 4,
                invalid: !!problems.fields["appearance.marginY"],
                ariaLabel: "垂直边距",
                onCommit: (v) => setPath(["appearance", "marginY"], v),
              }),
            ),
          ),
          h(
            SRow,
            { label: "气泡停留（秒）", hint: "4–120；主动消息与回复的气泡会自动消失", problem: problems.fields["appearance.bubbleSeconds"] },
            h(NumberField, {
              value: app.bubbleSeconds,
              min: 4,
              max: 120,
              step: 1,
              invalid: !!problems.fields["appearance.bubbleSeconds"],
              ariaLabel: "气泡停留秒数",
              onCommit: (v) => setPath(["appearance", "bubbleSeconds"], v),
            }),
          ),
          h(
            SRow,
            { label: "字体", hint: "candy = 上首软糖体（插件自带）；system = 系统字体", problem: problems.fields["appearance.fontFamily"] },
            h(
              "select",
              {
                className: "wc-s-select",
                value: app.fontFamily === "system" ? "system" : "candy",
                "aria-label": "气泡与面板字体",
                onChange: (e) => setPath(["appearance", "fontFamily"], e.target.value),
              },
              h("option", { value: "candy" }, "软糖体（candy）"),
              h("option", { value: "system" }, "系统字体（system）"),
            ),
          ),
        ),

        // ── 6. 状态与工具 ──────────────────────────────────────────────
        h(
          SGroup,
          { title: "状态与工具", desc: "只读状态来自宿主 runtime；工具按钮会立即调用宿主接口。" },
          h(
            SRow,
            { wide: true, label: "运行状态", hint: "刷新时机：打开设置页、保存、以及每次工具操作之后" },
            h("dl", { className: "wc-s-kv" }, kvNodes),
            h(
              "div",
              { className: "wc-s-note" },
              "宿主进程状态：" + (runtimeRoam.running ? "正在上网…" : "空闲") + "；数据目录见上。",
            ),
          ),
          h(
            SRow,
            { wide: true, label: "数据文件", hint: "配置文件、记忆、消息队列的绝对路径（只读）" },
            h("div", { className: "wc-s-out" }, renderPathsText(paths)),
          ),
          h(
            SRow,
            { wide: true, label: "工具", hint: "「立即上网」会忽略安静时段与每日上限，最长等 60 秒" },
            h(
              "div",
              { className: "wc-s-inline" },
              h(
                "button",
                { type: "button", className: "wc-s-btn is-2", onClick: runRoam, disabled: !!busy },
                busy === "roam" ? "上网中…" : "立即上网看看",
              ),
              h(
                "button",
                { type: "button", className: "wc-s-btn is-2", onClick: runWhisper, disabled: !!busy },
                busy === "whisper" ? "想说中…" : "发一句碎碎念",
              ),
              h(
                "button",
                { type: "button", className: "wc-s-btn is-2", onClick: runTestChat, disabled: !!busy },
                busy === "test" ? "测试中…" : "测试对话",
              ),
              confirmClear
                ? h(
                    "span",
                    { className: "wc-s-inline" },
                    h(
                      "button",
                      { type: "button", className: "wc-s-btn is-danger", onClick: doClearHistory, disabled: !!busy },
                      "确认清空",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "wc-s-btn is-2",
                        onClick: () => setConfirmClear(false),
                        disabled: !!busy,
                      },
                      "取消",
                    ),
                  )
                : h(
                    "button",
                    {
                      type: "button",
                      className: "wc-s-btn is-danger",
                      onClick: () => {
                        setConfirmClear(true);
                        setOut("");
                        setErr("");
                      },
                      disabled: !!busy,
                    },
                    "清空对话记忆",
                  ),
            ),
            confirmClear ? h("div", { className: "wc-s-note" }, "清空后不可恢复：memory.json 里的对话记录会被删除。") : null,
          ),
        ),

        // ── 底部：保存 / 读取 / 脏标记 ─────────────────────────────────
        h(
          "div",
          { className: "wc-s-actions" },
          h(
            "button",
            { type: "button", className: "wc-s-btn", onClick: save, disabled: !!busy || problemCount > 0, title: problemCount > 0 ? "先改好红字提示的内容" : "保存全部设置" },
            busy === "save" ? "保存中…" : "保存",
          ),
          reloadAsk
            ? h(
                "span",
                { className: "wc-s-inline" },
                h("span", { className: "wc-s-hint", style: { marginTop: "0" } }, "有未保存的改动，确定放弃并重新读取？"),
                h(
                  "button",
                  {
                    type: "button",
                    className: "wc-s-btn is-2",
                    onClick: () => {
                      setReloadAsk(false);
                      load();
                    },
                    disabled: !!busy,
                  },
                  "确定读取",
                ),
                h(
                  "button",
                  { type: "button", className: "wc-s-btn is-2", onClick: () => setReloadAsk(false), disabled: !!busy },
                  "取消",
                ),
              )
            : h(
                "button",
                {
                  type: "button",
                  className: "wc-s-btn is-2",
                  onClick: () => (dirty ? setReloadAsk(true) : load()),
                  disabled: !!busy,
                },
                "重新读取",
              ),
          dirty ? h("span", { className: "wc-s-dirty" }, "● 有改动还没保存") : null,
          problemCount > 0 ? h("span", { className: "wc-s-dirty", style: { color: "var(--dsw-alias-state-error-primary,#d33)" } }, "✗ 有 " + problemCount + " 处需要修改") : null,
        ),

        err ? h("div", { className: "wc-s-badbox", role: "alert" }, err) : null,
        out ? h("div", { className: "wc-s-out" }, out) : null,
        h(
          "div",
          { className: "wc-s-note", style: { marginTop: "10px" } },
          "小提示：外观、人设、对话设置保存后立即热生效；上网调度参数变化会重算下次时间。桌宠可以拖动，位置会自动保存。",
        ),
      );
    }

    // =========================================================================
    // 模块导出与槽位注册
    // =========================================================================

    const name = "dsh-whale-chat";
    const inject = ["slots"];

    function apply(ctx) {
      try {
        const slots = ctx && ctx.slots;
        if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
          warn("slots 服务不可用：桌宠与设置页都不会注册（插件本身仍加载成功）");
          return;
        }
        const mount = (slot, meta, component, label) => {
          try {
            const run = () => slots.inject(slot, function* () {
              yield slots.register(meta, component);
            });
            if (typeof ctx.effect === "function") ctx.effect(run, "dsh-whale-chat: " + label);
            else run();
          } catch (e) {
            warn("注册「" + label + "」失败：", errorText(e));
          }
        };
        mount("shell.overlay", { name: "shell.overlay", id: "dsh-whale-chat", order: 1200 }, WhaleChatOverlay, "桌宠浮层");
        mount(
          "settings.section",
          { name: "settings.section", id: "dsh-whale-chat-config", order: 40, label: () => "鲸聊" },
          WhaleChatSettings,
          "设置页",
        );
      } catch (e) {
        warn("apply 注册流程异常（界面可能不出现，但不会影响 DSH）：", errorText(e));
      }
    }

    module.exports = {
      name: name,
      inject: inject,
      apply: apply,
    };
    return module.exports;
  },
});
