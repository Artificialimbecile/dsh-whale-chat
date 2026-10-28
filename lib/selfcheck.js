/**
 * 自检页 `GET /dsh-whale-chat/selfcheck`（SPEC §7）。
 *
 * 目的：在没有浏览器、不能点设置页的环境里（headless `--dump-dom`）也能一次看到
 * 设置 / 状态 / 历史 / 消息四个接口是否正常，并能直接触发“测试对话”“立即上网”。
 *
 * 约束：纯 HTML + 内联 JS，零依赖；不出现任何 token、凭据、配置里的敏感值；
 * 所有 fetch 都用同源相对地址（页面本身就在可信栅栏后面，由 auth cookie 带着走）。
 */

/** 最小 HTML 转义（页面里只插版本号与数据目录，仍然按规矩转义） */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 生成自检页 HTML。
 * @param {{version?:string, dataDir?:string, pluginName?:string}} [options]
 * @returns {string}
 */
export function selfcheckHtml(options = {}) {
  const version = escapeHtml(options.version || '0.1.0')
  const dataDir = escapeHtml(options.dataDir || '（未知）')
  const pluginName = escapeHtml(options.pluginName || 'dsh-whale-chat')

  // 页面脚本：故意不做任何花哨的框架，出问题时“看得到哪一步挂了”比好看重要
  const script = `
let BASE = location.pathname.replace(/\\/selfcheck\\/?$/, '');
// 别名页 /selfcheck 的前缀是空串，接口仍在 /dsh-whale-chat 下
if (!BASE || BASE === '/') BASE = '/dsh-whale-chat';
const logEl = document.getElementById('log');
const outEl = document.getElementById('out');

function line(mark, text) {
  const div = document.createElement('div');
  div.className = 'line ' + mark;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = mark === 'ok' ? 'OK ' : mark === 'fail' ? 'FAIL' : '...';
  const pre = document.createElement('pre');
  pre.textContent = text;
  div.appendChild(tag);
  div.appendChild(pre);
  logEl.appendChild(div);
}

async function call(method, path, body) {
  const options = { method, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(BASE + path, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { ok: false, error: '返回的不是 JSON：' + text.slice(0, 200) }; }
  return { status: response.status, data };
}

async function step(label, method, path, body) {
  line('...', label + ' …');
  try {
    const result = await call(method, path, body);
    const ok = result.status >= 200 && result.status < 300 && result.data && result.data.ok !== false;
    line(ok ? 'ok' : 'fail', label + ' · HTTP ' + result.status + '\\n' + JSON.stringify(result.data, null, 2));
    return ok;
  } catch (error) {
    line('fail', label + ' · 请求失败：' + (error && error.message ? error.message : String(error)));
    return false;
  }
}

async function runAll() {
  logEl.textContent = '';
  line('...', '开始自检（' + new Date().toLocaleString() + '）');
  await step('设置 /api/settings', 'GET', '/api/settings');
  await step('状态 /api/status', 'GET', '/api/status');
  await step('历史 /api/history?limit=5', 'GET', '/api/history?limit=5');
  await step('消息 /api/messages?afterId=0&limit=5', 'GET', '/api/messages?afterId=0&limit=5');
  line('...', '自检结束');
}

async function testChat() {
  outEl.textContent = '正在测试对话…';
  try {
    const result = await call('POST', '/api/chat', { text: '在吗？用一句话回答我就好' });
    outEl.textContent = 'HTTP ' + result.status + '\\n' + JSON.stringify(result.data, null, 2);
  } catch (error) {
    outEl.textContent = '请求失败：' + (error && error.message ? error.message : String(error));
  }
}

async function roamNow() {
  outEl.textContent = '正在出门逛一圈（最长 60 秒）…';
  try {
    const result = await call('POST', '/api/roam', { force: true });
    outEl.textContent = 'HTTP ' + result.status + '\\n' + JSON.stringify(result.data, null, 2);
  } catch (error) {
    outEl.textContent = '请求失败：' + (error && error.message ? error.message : String(error));
  }
}

document.getElementById('rerun').addEventListener('click', () => { runAll(); });
document.getElementById('test-chat').addEventListener('click', () => { testChat(); });
document.getElementById('roam').addEventListener('click', () => { roamNow(); });
runAll();
`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pluginName} 自检</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; background: #f7f8fa; color: #1d2129; }
  @media (prefers-color-scheme: dark) { body { background: #17181b; color: #e8e8ea; } .card { background: #222327 !important; border-color: #3a3b41 !important; } pre { background: #1b1c20 !important; } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #86909c; font-size: 12px; margin-bottom: 16px; word-break: break-all; }
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 1px solid #c9cdd4; background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: #1664ff; border-color: #1664ff; color: #fff; }
  button:hover { filter: brightness(1.08); }
  .line { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-top: 1px dashed #e5e6eb; }
  .line:first-child { border-top: 0; }
  .tag { flex: 0 0 44px; font: 12px/22px ui-monospace, Consolas, monospace; }
  .ok .tag { color: #00a870; }
  .fail .tag { color: #e34d59; }
  pre { flex: 1; margin: 0; padding: 10px; background: #f2f3f5; border-radius: 8px; overflow: auto; max-height: 260px; font: 12px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  #out { min-height: 20px; }
</style>
</head>
<body>
  <h1>${pluginName} 自检</h1>
  <div class="meta">版本 ${version} · 数据目录 ${dataDir}</div>

  <div class="card">
    <div class="row">
      <button id="rerun" class="primary">重新自检</button>
      <button id="test-chat">测试对话</button>
      <button id="roam">立即上网</button>
    </div>
    <div id="log"></div>
  </div>

  <div class="card">
    <strong>手动操作结果</strong>
    <pre id="out">（还没操作）</pre>
  </div>

  <script>${script}</script>
</body>
</html>`
}
