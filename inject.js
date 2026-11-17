// 注入到两篇 Lark 文档页面里的联动脚本。
// 运行前由启动脚本写入 window.__LBX_DATA = { a: [块ID...], b: [块ID...], pairs: [[aId, bId], ...] }
(() => {
  if (window.__lbx) return;
  const DATA = window.__LBX_DATA;
  if (!DATA) return;

  const order = { a: new Map(), b: new Map() }; // 块 ID -> 在本篇中的序号
  DATA.a.forEach((id, i) => order.a.set(id, i));
  DATA.b.forEach((id, i) => order.b.set(id, i));
  const toOther = { a: new Map(), b: new Map() }; // 本篇块 ID -> 另一篇对应块 ID
  for (const [x, y] of DATA.pairs) {
    toOther.a.set(x, y);
    toOther.b.set(y, x);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cleanups = [];
  const listen = (type, fn, capture) => {
    document.addEventListener(type, fn, capture);
    cleanups.push(() => document.removeEventListener(type, fn, capture));
  };
  const esc = (id) => (window.CSS && CSS.escape ? CSS.escape(id) : id);
  const find = (id) => document.querySelector(`[data-record-id="${esc(id)}"]`);
  const rendered = () => [...document.querySelectorAll('[data-record-id]')];

  // 本页是哪一篇：看页面上已渲染的块属于哪篇
  let side = null;
  function mySide() {
    if (side) return side;
    for (const el of rendered()) {
      const id = el.dataset.recordId;
      if (order.a.has(id)) return (side = 'a');
      if (order.b.has(id)) return (side = 'b');
    }
    return null;
  }

  // 从任意节点找到它所属的、有对应关系的块
  function blockOf(node) {
    const s = mySide();
    if (!s || !node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const nearest = el && el.closest('[data-record-id]');
    for (let cur = nearest; cur; cur = cur.parentElement && cur.parentElement.closest('[data-record-id]')) {
      // 页面块包着整篇文档，只有直接选中标题时才算数
      if (cur.dataset.blockType === 'page' && cur !== nearest) return null;
      if (toOther[s].has(cur.dataset.recordId)) return cur.dataset.recordId;
    }
    return null;
  }

  // ---------- 高亮：只写一条样式规则，不改文档里的任何节点 ----------
  const styleEl = document.createElement('style');
  styleEl.id = 'lbx-highlight';
  (document.head || document.documentElement).appendChild(styleEl);
  function paint(ids) {
    if (!ids.length) {
      styleEl.textContent = '';
      return;
    }
    const sel = ids.map((id) => `[data-record-id="${esc(id)}"]:not([data-block-type="page"])`).join(',');
    const titleSel = ids.map((id) => `[data-record-id="${esc(id)}"][data-block-type="page"] .page-block-header`).join(',');
    styleEl.textContent =
      `${sel},${titleSel}{background:rgba(255,198,10,.26)!important;` +
      `box-shadow:-4px 0 0 0 #f5a623, 0 0 0 4px rgba(255,198,10,.26)!important;border-radius:2px;` +
      `transition:background .15s}`;
  }

  // ---------- 滚动到目标块：Lark 只渲染视口附近的块，要边滚边找 ----------
  function scrollerOf(el) {
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const st = getComputedStyle(cur);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && cur.scrollHeight > cur.clientHeight + 50) return cur;
    }
    return document.scrollingElement;
  }
  let revealToken = 0;
  let muteUntil = 0; // 这之前的滚动是程序触发的，不向对面广播
  const mute = (ms) => (muteUntil = Math.max(muteUntil, Date.now() + ms));
  async function reveal(id) {
    const s = mySide();
    if (!s) return;
    const token = ++revealToken;
    const target = order[s].get(id);
    const total = order[s].size;
    for (let i = 0; i < 60 && token === revealToken; i++) {
      const el = find(id);
      if (el) {
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        mute(400);
        if (r.top < 80 || r.bottom > vh - 40) el.scrollIntoView({ block: 'center' });
        return el;
      }
      // 只看视口内的叶子块：Lark 会在视口外保留零散的块，表格这类容器又会跨很多屏
      const vh = window.innerHeight;
      const els = rendered().filter((e) => {
        if (!order[s].has(e.dataset.recordId) || e.querySelector('[data-record-id]')) return false;
        const r = e.getBoundingClientRect();
        return r.height > 0 && r.bottom > 0 && r.top < vh;
      });
      const idxs = els.map((e) => order[s].get(e.dataset.recordId));
      if (!idxs.length) {
        await sleep(150);
        continue;
      }
      const sc = scrollerOf(els[0]);
      mute(600);
      const lo = Math.min(...idxs);
      const hi = Math.max(...idxs);
      if (i === 0 && (target < lo - 40 || target > hi + 40)) {
        sc.scrollTop = (target / total) * sc.scrollHeight - sc.clientHeight / 2; // 离得远，先按比例跳
      } else if (target < lo) {
        sc.scrollTop -= sc.clientHeight * 0.85;
      } else if (target > hi) {
        sc.scrollTop += sc.clientHeight * 0.85;
      } else {
        await sleep(150); // 在已渲染范围内但节点还没出来，等一下
        continue;
      }
      await sleep(110);
    }
    return null;
  }

  // ---------- 两个页面之间传消息（同域，直接广播） ----------
  const channel = new BroadcastChannel('lbx-' + DATA.key);
  channel.onmessage = (ev) => {
    const msg = ev.data || {};
    const s = mySide();
    if (!s || msg.to !== s) return;
    if (msg.type === 'scroll') return void applyScroll(msg.id, msg.frac);
    if (msg.type === 'hscroll') return void applyTableScroll(msg.id, msg.off);
    paint(msg.ids);
    if (msg.ids.length) reveal(msg.ids[0]);
    else revealToken++;
  };


  // ---------- 滚动同步：对齐「视口上方 1/4 处那一块」而不是像素，两种语言段落高度不同也不会越滚越偏 ----------
  const visibleLeaves = (s) => {
    const vh = window.innerHeight;
    const out = [];
    for (const e of rendered()) {
      if (!toOther[s].has(e.dataset.recordId) || e.dataset.blockType === 'page' || e.querySelector('[data-record-id]')) continue;
      const r = e.getBoundingClientRect();
      if (r.height > 0 && r.bottom > 0 && r.top < vh) out.push([e, r]);
    }
    return out;
  };
  const anchorY = () => Math.round(window.innerHeight * 0.25);
  let lastScrollSent = '';
  function sendScroll() {
    const s = mySide();
    if (!s || DATA.scrollSync === false || Date.now() < muteUntil) return;
    const y = anchorY();
    let best = null;
    for (const [e, r] of visibleLeaves(s)) {
      if (r.bottom <= y) continue;
      if (!best || r.top < best[1].top) best = [e, r];
    }
    if (!best) return;
    const [e, r] = best;
    const frac = Math.min(1, Math.max(0, (y - r.top) / r.height));
    const id = toOther[s].get(e.dataset.recordId);
    const sig = id + ':' + frac.toFixed(2);
    if (sig === lastScrollSent) return;
    lastScrollSent = sig;
    channel.postMessage({ type: 'scroll', to: s === 'a' ? 'b' : 'a', id, frac });
  }
  let scrollSeq = 0;
  async function applyScroll(id, frac) {
    const seq = ++scrollSeq;
    activeUntil = 0;
    mute(500);
    let el = find(id);
    if (!el || el.getBoundingClientRect().height === 0) el = await reveal(id);
    if (!el || seq !== scrollSeq) return;
    const r = el.getBoundingClientRect();
    const sc = scrollerOf(el);
    mute(400);
    sc.scrollTop += r.top + frac * r.height - anchorY();
  }
  // 只有人正在操作的那一边才发滚动位置；程序引起的滚动（跟随对面、Lark 懒加载撑高页面）一律不发，
  // 否则两边会互相推着走
  let activeUntil = 0;
  let pointerDown = false;
  const touch = (e) => {
    if (e && e.isTrusted === false) return; // 程序发的事件（跟随对面时模拟的滚轮）不算人在操作
    activeUntil = Date.now() + 1200;
    watchTables();
  };
  listen('wheel', touch, { capture: true, passive: true });
  listen('touchmove', touch, { capture: true, passive: true });
  listen('keydown', touch, true);
  listen('pointerdown', (e) => ((pointerDown = true), touch(e)), true); // 拖滚动条
  listen('pointerup', (e) => ((pointerDown = false), touch(e)), true);
  const userDriven = () => pointerDown || Date.now() < activeUntil;

  // ---------- 表格横向滚动同步 ----------
  // Lark 表格的横向滚动发生在表格内部一个隐藏溢出的容器（.content-scroller）上，由 Lark 自己改它的 scrollLeft。
  // 所以：人在操作时定时读各表格的 scrollLeft，变了就发给对面；对面直接设成同一个值并补发 scroll 事件，
  // 让 Lark 的滑块跟着更新（实测有效）。
  const tableScroller = (block) => block.querySelector('.content-scroller');
  const sentOffsets = new Map();
  let tableTimer = 0;
  function watchTables() {
    if (tableTimer || DATA.scrollSync === false) return;
    tableTimer = setInterval(() => {
      const s = mySide();
      if (!s || !userDriven()) {
        clearInterval(tableTimer);
        tableTimer = 0;
        return;
      }
      const vh = window.innerHeight;
      for (const block of document.querySelectorAll('[data-block-type="table"][data-record-id]')) {
        const other = toOther[s].get(block.dataset.recordId);
        const r = block.getBoundingClientRect();
        if (!other || r.bottom < 0 || r.top > vh) continue;
        const sc = tableScroller(block);
        if (!sc) continue;
        const off = Math.round(sc.scrollLeft);
        const prev = sentOffsets.get(other);
        sentOffsets.set(other, off);
        if (prev === off) continue; // 发的是绝对偏移，重复发也无害
        channel.postMessage({ type: 'hscroll', to: s === 'a' ? 'b' : 'a', id: other, off });
      }
    }, 80);
    cleanups.push(() => clearInterval(tableTimer));
  }
  function applyTableScroll(id, off) {
    activeUntil = 0;
    const block = find(id);
    const sc = block && tableScroller(block);
    if (!sc) return;
    sc.scrollLeft = off; // 两边列宽一样，用同一个像素偏移；超出范围浏览器会自动截到头
    sc.dispatchEvent(new Event('scroll', { bubbles: true }));
    sentOffsets.set(toOther[mySide()].get(id), Math.round(sc.scrollLeft));
  }

  let scrollTimer = 0;
  let scrollLast = 0;
  listen(
    'scroll',
    () => {
      if (!userDriven() || Date.now() < muteUntil) return;
      clearTimeout(scrollTimer);
      const wait = Math.max(0, 50 - (Date.now() - scrollLast)); // 最多每 50 毫秒发一次，停下后补发最后一次
      scrollTimer = setTimeout(() => {
        scrollLast = Date.now();
        sendScroll();
      }, wait);
    },
    true
  );

  let lastSent = '';
  function sync() {
    const s = mySide();
    if (!s) return;
    const selection = document.getSelection();
    if (!selection || !selection.rangeCount) return;
    const from = blockOf(selection.anchorNode);
    const to = blockOf(selection.focusNode);
    if (!from && !to) return;
    let i = order[s].get(from || to);
    let j = order[s].get(to || from);
    if (i > j) [i, j] = [j, i];
    j = Math.min(j, i + 60);
    const mine = DATA[s];
    const ids = [];
    for (let k = i; k <= j; k++) {
      const other = toOther[s].get(mine[k]);
      if (other) ids.push(other);
    }
    const sig = ids.join(',');
    if (sig === lastSent) return;
    lastSent = sig;
    paint([]); // 自己这边是发起方，清掉之前别人标给我的高亮
    channel.postMessage({ to: s === 'a' ? 'b' : 'a', ids });
  }

  let timer = 0;
  listen('selectionchange', () => {
    clearTimeout(timer);
    timer = setTimeout(sync, 120);
  });
  listen(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      lastSent = '';
      paint([]);
      channel.postMessage({ to: mySide() === 'a' ? 'b' : 'a', ids: [] });
    },
    true
  );

  // 整体卸载：工具换一对文档重新接管、或退出时调用
  function off() {
    cleanups.forEach((fn) => fn());
    clearTimeout(timer);
    clearTimeout(scrollTimer);
    revealToken++;
    scrollSeq++;
    channel.close();
    styleEl.remove();
    delete window.__lbx;
    delete window.__LBX_DATA;
  }
  window.__lbx = { mySide, paint, reveal, sync, off, touch, stamp: DATA.stamp };
})();
