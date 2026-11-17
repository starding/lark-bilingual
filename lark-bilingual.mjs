#!/usr/bin/env node
// 用法：node lark-bilingual.mjs <文档A链接> <文档B链接> [--isolated]
// 在已登录的 Chrome 里打开左右两个窗口，在一边选中文字，另一边对应段落高亮并滚动到位。Esc 清除高亮。
// 依赖：Node 22+、Google Chrome、已登录的 lark-cli。无其他依赖。
// 前提：Chrome 菜单「视图 → 开发者 → 允许 Apple 事件中的 JavaScript」已打开。
// 不想开这个开关时加 --isolated，改用独立配置的 Chrome（要在里面另登录一次 Lark）。

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = join(homedir(), '.lark-bilingual');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const dumpOnly = args.includes('--dump'); // 只生成对应表，不开浏览器（调试用）
const isolated = args.includes('--isolated'); // 改用独立配置的 Chrome（需在其中另登录一次 Lark）
const gui = args.includes('--gui'); // 由应用启动：提示和报错用对话框
const noScroll = args.includes('--no-scroll'); // 只联动高亮，不同步滚动位置
let urls = args.filter((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const osa = (lang, code, ...argv) =>
  execFileSync('osascript', [...(lang === 'js' ? ['-l', 'JavaScript'] : []), '-e', code, ...argv], { encoding: 'utf8' }).trim();
const TITLE = 'Lark 双语对照';
function notify(msg) {
  console.log(msg);
  if (gui) osa('as', 'on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv)\nend run', msg, TITLE);
}
function fail(msg) {
  console.error(msg);
  if (gui) osa('as', 'on run argv\ndisplay dialog (item 1 of argv) with title (item 2 of argv) buttons {"好"} default button 1 with icon caution\nend run', msg, TITLE);
  process.exit(1);
}

// 没给链接时：用 Chrome 里已经打开的两篇 Lark 文档（每个窗口当前的标签页，靠前的两个）
const isDoc = (u) => /(larksuite|feishu|larkoffice)\.[a-z.]+\/(wiki|docx|docs)\//.test(u);
const LIST = `set sep to character id 9 -- 在 Chrome 的 tell 块里 tab 指的是标签页，不能当分隔符
tell application "Google Chrome"
  set out to ""
  repeat with w in windows
    set b to bounds of w
    repeat with t in tabs of w
      set out to out & (id of w) & sep & (id of t) & sep & (item 1 of b) & sep & (URL of t) & sep & (title of t) & linefeed
    end repeat
  end repeat
  return out
end tell`;
const bare = (u) => u.split(/[?#]/)[0];
// Lark 会在标题里掺不可见的水印字符，去掉（保留可打印字符）
const cleanTitle = (t) => t.replace(/[\p{Cf}]/gu, '').replace(/ - (Lark|Feishu) Docs$/, '').trim();
const listDocTabs = () =>
  osa('as', LIST)
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((f) => f.length === 5 && isDoc(f[3]))
    .map((f) => ({ win: f[0], tab: f[1], left: +f[2], url: f[3], title: cleanTitle(f[4]) }));
let attach = null; // [[窗口ID, 标签页ID], ...]，非空表示接管现有窗口
if (urls.length === 0 && !isolated) {
  let open = listDocTabs();
  if (open.length > 2) {
    // 开着不止两篇，不猜：让人指定
    const labels = open.map((o, i) => `${i + 1}. ${o.title}`);
    if (!gui) fail('Chrome 里开着 ' + open.length + ' 个 Lark 文档标签页，分不清要对照哪两篇：\n' + labels.join('\n') + '\n请把两篇的链接作为参数传入。');
    const pick = `on run argv
  set r to choose from list argv with title "${TITLE}" with prompt "开着不止两篇 Lark 文档，请选出要对照的两篇（按住 ⌘ 多选）：" with multiple selections allowed
  if r is false then return ""
  set AppleScript's text item delimiters to linefeed
  return r as text
end run`;
    const chosen = osa('as', pick, ...labels).split('\n').filter(Boolean);
    if (!chosen.length) process.exit(0); // 用户取消
    if (chosen.length !== 2) fail('需要正好选两篇，你选了 ' + chosen.length + ' 篇。');
    open = chosen.map((c) => open[parseInt(c, 10) - 1]);
  }
  if (open.length === 2) {
    if (bare(open[0].url) === bare(open[1].url)) fail('两个标签页开的是同一篇文档。');
    open.sort((x, y) => x.left - y.left); // 靠左的窗口放左边
    attach = open.map((o) => [o.win, o.tab]);
    urls = open.map((o) => o.url);
  } else if (gui) {
    const ask = `display dialog "没有在 Chrome 里找到两篇打开的 Lark 文档。" & return & return & "请粘贴两篇文档的链接，用空格或换行隔开：" with title "${TITLE}" default answer "" buttons {"取消", "打开"} default button 2
return text returned of result`;
    try {
      urls = osa('as', ask).split(/\s+/).filter(Boolean);
    } catch {
      process.exit(0); // 用户取消
    }
  }
}
urls = urls.map(bare);
// 给了链接、而这两篇已经在 Chrome 里开着：直接接管，不再另开窗口
if (!attach && !isolated && urls.length === 2) {
  const tabs = listDocTabs();
  const [as, bs] = urls.map((u) => tabs.filter((t) => bare(t.url) === u));
  // 同一篇可能开在好几个标签页里：优先取在同一个窗口里的那一对（分屏）
  const pair = as.flatMap((x) => bs.map((y) => [x, y])).sort((p, q) => (q[0].win === q[1].win) - (p[0].win === p[1].win))[0];
  if (pair) attach = pair.map((o) => [o.win, o.tab]);
}
if (urls.length !== 2) {
  fail('需要两篇文档。用法：node lark-bilingual.mjs [<文档A链接> <文档B链接>]\n不带链接时，会接管 Chrome 里已打开的两篇 Lark 文档（两个窗口各一篇，或同一窗口里分屏的两个标签页）。');
}

// ---------- 1. 拉两篇文档的块列表 ----------
function fetchBlocks(url) {
  let out;
  try {
    out = execFileSync('lark-cli', ['docs', '+fetch', '--as', 'user', '--doc', url, '--detail', 'with-ids'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    fail('读取文档失败：' + url + '\n' + String(e.stderr || e.message).slice(0, 300));
  }
  const content = JSON.parse(out).data.document.content;
  const blocks = [];
  const re = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*\/?>/g;
  for (let m; (m = re.exec(content)); ) {
    const id = /(?:^|\s)id="([^"]+)"/.exec(m[2]);
    if (id) blocks.push({ tag: m[1], id: id[1] });
  }
  return blocks;
}

// ---------- 2. 对齐：结构相同就按顺序配对，否则按块类型序列求最长公共子序列 ----------
function align(a, b) {
  if (a.length === b.length && a.every((x, i) => x.tag === b[i].tag)) {
    return { pairs: a.map((x, i) => [x.id, b[i].id]), exact: true };
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i].tag === b[j].tag ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i].tag === b[j].tag && dp[i][j] === dp[i + 1][j + 1] + 1) pairs.push([a[i++].id, b[j++].id]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { pairs, exact: false };
}

notify('正在读取两篇文档…');
const a = fetchBlocks(urls[0]);
const b = fetchBlocks(urls[1]);
const { pairs, exact } = align(a, b);
console.log(`A ${a.length} 块，B ${b.length} 块，配对 ${pairs.length} 对` + (exact ? '（结构完全一致）' : ''));
if (!exact) {
  console.warn('注意：两篇结构不完全一致，已按块类型顺序尽量对齐；增删过段落的位置附近可能对不准。');
}

const stamp = String(Date.now());
const data = { key: a[0].id + '-' + b[0].id, stamp, scrollSync: !noScroll, a: a.map((x) => x.id), b: b.map((x) => x.id), pairs };
const script = `window.__LBX_DATA=${JSON.stringify(data)};\n` + readFileSync(join(HERE, 'inject.js'), 'utf8');

mkdirSync(HOME, { recursive: true });
const scriptPath = join(HOME, 'last-inject.js');
writeFileSync(scriptPath, script);
if (dumpOnly) {
  console.log('已写出', scriptPath);
  process.exit(0);
}

// ---------- 3a. 默认：用已登录的 Chrome，通过苹果脚本开窗口并注入 ----------
const OPEN = `on run argv
  tell application "Google Chrome"
    -- 建窗口时就带上位置：当前窗口是全屏时，不带位置新建的窗口也会变成全屏，没法并排
    set w to make new window with properties {bounds:{(item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer}}
    set URL of active tab of w to (item 1 of argv)
    return ((id of w) as text) & "," & ((id of active tab of w) as text)
  end tell
end run`;
// 返回 y=已注入 n=刚注入 w=页面还在加载 gone=窗口或标签页已关
const INJECT = `on run argv
  set src to read POSIX file (item 3 of argv) as «class utf8»
  tell application "Google Chrome"
    try
      set t to first tab of window id ((item 1 of argv) as integer) whose id is ((item 2 of argv) as integer)
    on error
      return "gone"
    end try
    set r to execute t javascript "window.__lbx ? (window.__lbx.stamp === '" & (item 4 of argv) & "' ? 'y' : (window.__lbx.off ? window.__lbx.off() : delete window.__lbx, 'n')) : (document.readyState === 'loading' || location.href === 'about:blank' ? 'w' : 'n')"
    if r is "n" then execute t javascript src
    return r
  end tell
end run`;

async function runInLoggedInChrome() {
  const [sx, sy, sw, sh] = JSON.parse(
    osa('js', 'ObjC.import("AppKit"); var s=$.NSScreen.mainScreen, f=s.visibleFrame, a=s.frame; JSON.stringify([f.origin.x, a.size.height-(f.origin.y+f.size.height), f.size.width, f.size.height])')
  );
  const half = Math.floor(sw / 2);
  const boxes = [
    [sx, sy, sx + half, sy + sh],
    [sx + half, sy, sx + sw, sy + sh],
  ];
  let wins;
  if (attach) {
    wins = attach;
    const sameWindow = wins[0][0] === wins[1][0];
    if (sameWindow) console.log('两篇在同一个窗口里，按 Chrome 分屏处理，不调整窗口。');
    const placed = sameWindow ? [] : wins.map(([winId], i) =>
      osa('as', 'on run argv\ntell application "Google Chrome"\nset w to window id ((item 1 of argv) as integer)\nset bounds of w to {(item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer}\nset b to bounds of w\nreturn (item 1 of b) as text\nend tell\nend run', winId, ...boxes[i]) === String(boxes[i][0])
    );
    if (placed.includes(false)) notify('有窗口处于全屏，没法自动并排。联动照常可用；要并排请先退出全屏再运行。');
  } else {
    wins = urls.map((u, i) => osa('as', OPEN, u, ...boxes[i]).split(','));
  }
  notify((attach ? '已接管两篇文档' : '已打开两个窗口') + (exact ? '' : '（两篇结构不完全一致，部分段落可能对不准）') + '。选中或滚动一边，另一边跟随；Esc 清除高亮。');
  console.log('关掉这两篇文档或按 Ctrl+C 结束。');
  const injected = [false, false];
  // 退出时把页面里的联动脚本卸掉，不在你的文档页里留东西
  const unload = () => {
    for (const [winId, tabId] of wins) {
      try {
        osa('as', 'on run argv\ntell application "Google Chrome" to execute (first tab of window id ((item 1 of argv) as integer) whose id is ((item 2 of argv) as integer)) javascript "window.__lbx && window.__lbx.off && window.__lbx.off()"\nend run', winId, tabId);
      } catch {}
    }
    process.exit(0);
  };
  process.on('SIGINT', unload);
  process.on('SIGTERM', unload);
  for (;;) {
    await sleep(1500);
    let alive = 0;
    for (const [i, [winId, tabId]] of wins.entries()) {
      let r;
      try {
        r = osa('as', INJECT, winId, tabId, scriptPath, stamp);
      } catch (e) {
        if (/turned off|Apple Events|AppleScript/.test(String(e.stderr || e))) {
          fail('Chrome 还不允许外部脚本在页面里执行代码。\n请在 Chrome 菜单打开：视图 → 开发者 → 允许 Apple 事件中的 JavaScript，然后重新运行。');
        }
        throw e;
      }
      if (r === 'gone') continue;
      alive++;
      if (r === 'n') console.log(`${injected[i] ? '页面刷新，重新' : ''}接管第 ${i + 1} 篇`);
      if (r === 'n') injected[i] = true;
    }
    if (!alive) process.exit(0);
  }
}
if (!isolated) await runInLoggedInChrome();

// ---------- 3b. 备选：启动独立配置的 Chrome，通过调试接口注入 ----------
const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const port = await freePort();
const chrome = spawn(
  CHROME,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${join(HOME, 'chrome-profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
  { stdio: 'ignore' }
);
chrome.on('exit', () => process.exit(0));
process.on('SIGINT', () => {
  chrome.kill();
  process.exit(0);
});

let version;
for (let i = 0; i < 100 && !version; i++) {
  await sleep(200);
  version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null);
}
if (!version) {
  console.error('Chrome 没有启动成功。如果上一次的窗口还开着，请先关掉再试。');
  process.exit(1);
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
};
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

// 屏幕可用区域，用来左右平分
const { targetInfos } = await send('Target.getTargets');
const first = targetInfos.find((t) => t.type === 'page');
const { sessionId: s0 } = await send('Target.attachToTarget', { targetId: first.targetId, flatten: true });
const screen = (
  await send('Runtime.evaluate', { expression: 'JSON.stringify([screen.availLeft||0,screen.availTop||0,screen.availWidth,screen.availHeight])', returnByValue: true }, s0)
).result.value;
const [sx, sy, sw, sh] = JSON.parse(screen);
const half = Math.floor(sw / 2);

async function open(url, left, reuseTargetId) {
  const targetId = reuseTargetId || (await send('Target.createTarget', { url: 'about:blank', newWindow: true })).targetId;
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: script }, sessionId); // 登录跳转、刷新后仍然生效
  const { windowId } = await send('Browser.getWindowForTarget', { targetId });
  await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await send('Browser.setWindowBounds', { windowId, bounds: { left, top: sy, width: half, height: sh } });
  await send('Page.navigate', { url }, sessionId);
}
await open(urls[0], sx, first.targetId);
await open(urls[1], sx + half);

console.log('已打开两个窗口。首次使用需要在窗口里登录一次 Lark。');
console.log('在一边选中文字，另一边对应段落会高亮；按 Esc 清除。关闭浏览器或按 Ctrl+C 结束。');
