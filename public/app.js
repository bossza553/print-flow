/* Print Flow – client app (vanilla JS, no build step) */
(() => {
  'use strict';

  // ------------------------------------------------------------ state
  const S = {
    token: localStorage.getItem('pf_token') || null,
    user: null,
    meta: null,
    basket: JSON.parse(localStorage.getItem('pf_basket') || '[]'),
    view: null,
    cache: {},          // per-view data
    knownQueueIds: null, // for "new job" detection
    pollTimer: null,
    pushSub: null,
  };
  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet-root');
  // API base: same origin by default, or the Supabase Edge Function when configured (config.js)
  const API = (window.PF_CONFIG && window.PF_CONFIG.apiBase) || '';
  // Running inside the native Android app? It injects window.Android and handles alarms itself.
  const NATIVE = !!(window.Android && typeof window.Android.onLogin === 'function');
  const nativeLogin = (token) => { if (NATIVE) { try { window.Android.onLogin(token); } catch { /* ignore */ } } };
  const nativeLogout = () => { if (NATIVE) { try { window.Android.onLogout(); } catch { /* ignore */ } } };

  // ------------------------------------------------------------ utils
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('th-TH');
  const parseDate = (s) => s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z') : null;
  const fmtTime = (s) => { const d = parseDate(s); return d ? d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; };
  const ago = (s) => {
    const d = parseDate(s); if (!d) return '';
    const m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return 'เมื่อสักครู่';
    if (m < 60) return `${m} นาทีที่แล้ว`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ชม.ที่แล้ว`;
    return `${Math.round(h / 24)} วันที่แล้ว`;
  };
  const stageName = (k) => S.meta?.stages.find(s => s.key === k)?.name || k;
  const stageIndex = (k) => S.meta?.stages.findIndex(s => s.key === k) ?? -1;
  const roleName = (r) => S.meta?.roles[r] || r;
  const statusName = { waiting: 'รอคิว', working: 'กำลังทำ', done: 'เสร็จแล้ว', cancelled: 'ยกเลิก' };
  const EV_NAME = { created: 'ส่งงานเข้าสายการผลิต', start: 'เริ่มทำ', finish: 'ทำเสร็จ ส่งต่อ', cancel: 'ยกเลิกงาน' };
  const qtyFmt = (n) => Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });

  // ---- printing plates (เพลท) vs ยก -------------------------------------
  // Admin and press operators count in printing plates; after the press everyone works in ยก.
  const platesPerYok = () => S.meta?.platesPerYok || 2;
  const yokOf = (pages) => pages == null ? null : Math.round((Number(pages) / platesPerYok()) * 10) / 10;
  const yokFmt = (n) => Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 1 });
  const seesPlates = () => S.user && (S.user.role === 'admin' || S.user.role === 'printer');
  // true once the job has left the press (fold onwards, or done)
  const printed = (j) => j.status === 'done' || stageIndex(j.stage) > stageIndex('print');
  // The big เพลท / ยก chip. Admin and the press see plates until the job leaves the press;
  // from พับ onward everyone, admin included, sees ยก only.
  function unitChip(j, big = false) {
    const yok = j.yok ?? yokOf(j.plates);
    if (yok == null) return '';
    const cls = `unit${big ? ' big' : ''}`;
    if (!printed(j) && seesPlates() && j.plates != null) {
      const eq = S.user.role === 'admin' ? `<span class="eq">= ${yokFmt(yok)} ยก</span>` : '';
      return `<span class="${cls} plates"><b>${num(j.plates)}</b> เพลท${eq}</span>`;
    }
    return `<span class="${cls} yok"><b>${yokFmt(yok)}</b> ยก</span>`;
  }

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    document.getElementById('toast').appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  // ---------------------------------------------------------- alarm siren
  // One AudioContext, unlocked on the first tap so it can play later even if
  // the alarm is triggered by a push message while the screen is elsewhere.
  let audioCtx = null;
  function getAudio() {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch { /* unsupported */ }
    return audioCtx;
  }
  ['touchstart', 'pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, getAudio, { once: true, passive: true }));

  let alarm = null; // { stop() }
  function startAlarm(title, body) {
    stopAlarm();
    const ctx = getAudio();
    let timer = null, vib = null;
    if (ctx) {
      // two-tone siren at full gain, repeats until stopped or 20 s
      const master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
      const tone = (f, t, d) => {
        for (const [type, mult, gain] of [['square', 1, 0.9], ['sawtooth', 0.5, 0.6]]) {
          const o = ctx.createOscillator(); const g = ctx.createGain(); o.type = type; o.frequency.value = f * mult;
          g.gain.setValueAtTime(gain, t); g.gain.setValueAtTime(0, t + d); o.connect(g); g.connect(master); o.start(t); o.stop(t + d + 0.02);
        }
      };
      // continuous two-tone siren: 4 x (high/low) per 2 s, no gaps
      const burst = () => { const t = ctx.currentTime; for (let i = 0; i < 4; i++) { tone(1200, t + i * 0.5, 0.25); tone(800, t + i * 0.5 + 0.25, 0.25); } };
      burst(); timer = setInterval(burst, 2000);
      alarm = { stop() { clearInterval(timer); clearInterval(vib); try { master.disconnect(); } catch { /* ignore */ } } };
    } else {
      alarm = { stop() { clearInterval(vib); } };
    }
    if (navigator.vibrate) { navigator.vibrate([800, 200, 800, 200, 800]); vib = setInterval(() => navigator.vibrate([800, 200, 800, 200, 800]), 3000); }
    const ov = document.createElement('div');
    ov.id = 'alarmOverlay';
    ov.innerHTML = `<div class="alarm-box"><div class="alarm-ic">🚨</div><div class="alarm-title">${esc(title || 'งานใหม่!')}</div><div class="alarm-body">${esc(body || '')}</div><button class="btn big" id="alarmOk">รับทราบ</button></div>`;
    document.body.appendChild(ov);
    const ack = () => { stopAlarm(); location.hash = S.user?.role === 'admin' ? '#board' : '#queue'; render(true); };
    ov.querySelector('#alarmOk').onclick = ack;
    ov.onclick = ack; // any tap counts: the goal is attention, not noise
    // keeps going until someone taps รับทราบ (hard stop after 10 minutes so an empty room isn't a siren all night)
    alarmCap = setTimeout(stopAlarm, 10 * 60 * 1000);
  }
  let alarmCap = null;
  function stopAlarm() {
    clearTimeout(alarmCap);
    alarm?.stop(); alarm = null;
    if (navigator.vibrate) navigator.vibrate(0);
    document.getElementById('alarmOverlay')?.remove();
  }
  function beep() { if (NATIVE) return; startAlarm('งานใหม่มาถึงแล้ว!', 'แตะรับทราบ แล้วกดเริ่มทำงานในคิว'); }

  // the service worker forwards every push to open pages so the siren sounds immediately
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'push' && S.user) {
        if (e.data.alarm && S.user.role !== 'admin') startAlarm(e.data.title, e.data.body); else toast(e.data.title, 'success');
        if (['queue', 'board'].includes(currentHash().split('/')[0])) render();
      }
    });
  }

  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && S.token) { logoutLocal(); }
    if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
    return data;
  }

  function saveBasket() { localStorage.setItem('pf_basket', JSON.stringify(S.basket)); }

  // ------------------------------------------------------------ sheet (modal)
  function openSheet(html, onMount) {
    $sheet.innerHTML = `<div class="sheet-backdrop" data-close="1"><div class="sheet"><div class="handle"></div>${html}</div></div>`;
    const bd = $sheet.firstElementChild;
    bd.addEventListener('click', (e) => { if (e.target === bd) closeSheet(); });
    onMount?.($sheet.querySelector('.sheet'));
  }
  function closeSheet() { $sheet.innerHTML = ''; }

  function confirmSheet(title, body, okLabel, okClass = 'success') {
    return new Promise((resolve) => {
      openSheet(`
        <h2>${esc(title)}</h2>
        <p class="muted">${body}</p>
        <div class="actions">
          <button class="btn secondary" data-x="no">ยกเลิก</button>
          <button class="btn ${okClass}" data-x="yes">${esc(okLabel)}</button>
        </div>`, (el) => {
        el.querySelector('[data-x=no]').onclick = () => { closeSheet(); resolve(false); };
        el.querySelector('[data-x=yes]').onclick = () => { closeSheet(); resolve(true); };
      });
    });
  }

  // ------------------------------------------------------------ routing
  const ADMIN_TABS = [
    { hash: 'board', label: 'งาน', ic: '📋' },
    { hash: 'books', label: 'หนังสือ', ic: '📚' },
    { hash: 'basket', label: 'ตะกร้า', ic: '🧺' },
    { hash: 'paper', label: 'สต็อก', ic: '📦' },
    { hash: 'log', label: 'บันทึก', ic: '📅' },
    { hash: 'users', label: 'พนักงาน', ic: '👷' },
    { hash: 'settings', label: 'ตั้งค่า', ic: '⚙️' },
  ];
  const WORKER_TABS = [
    { hash: 'queue', label: 'งานของฉัน', ic: '🛠️' },
    { hash: 'board', label: 'ภาพรวม', ic: '📋' },
    { hash: 'paper', label: 'สต็อก', ic: '📦' },
    { hash: 'settings', label: 'ตั้งค่า', ic: '⚙️' },
  ];

  function currentHash() {
    const h = location.hash.replace(/^#/, '');
    if (h) return h;
    return S.user?.role === 'admin' ? 'board' : 'queue';
  }

  window.addEventListener('hashchange', render);

  // ------------------------------------------------------------ shell
  function shell(title, sub, bodyHtml) {
    const tabs = S.user.role === 'admin' ? ADMIN_TABS : WORKER_TABS;
    const cur = currentHash().split('/')[0];
    return `
      <header class="topbar">
        <div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
        <div class="sub">${esc(S.user.name)}</div>
      </header>
      <main class="page">${bodyHtml}</main>
      <nav class="bottomnav">
        ${tabs.map(t => `<a href="#${t.hash}" class="${cur === t.hash ? 'active' : ''}">
            <span class="ic">${t.ic}</span>${t.label}
            ${t.hash === 'basket' && S.basket.length ? `<span class="dot">${S.basket.length}</span>` : ''}
          </a>`).join('')}
      </nav>`;
  }

  function jobCard(j, { showStage = true } = {}) {
    return `
      <div class="card tap" data-job="${j.id}">
        <div class="row between">
          <div class="title">${esc(j.book_title)}</div>
          <span class="badge ${j.status}">${statusName[j.status]}</span>
        </div>
        <div class="row between" style="margin-top:8px;align-items:center">
          <div class="row wrap" style="gap:6px">
            <span class="badge color">${esc(j.color)}</span>
            <span class="badge">${num(j.quantity)} เล่ม</span>
            ${showStage ? `<span class="badge">${esc(stageName(j.stage))}</span>` : ''}
            ${j.machine ? `<span class="badge">เครื่อง ${esc(j.machine)}</span>` : ''}
          </div>
          ${unitChip(j)}
        </div>
        <div class="meta">
          ${j.book_code ? `รหัส ${esc(j.book_code)} · ` : ''}#${j.id} · ${ago(j.updated_at)}
          ${j.worker_name ? ` · ${esc(j.worker_name)}` : ''}
          ${j.paper_name ? `<br>📄 ${esc(j.paper_name)}${j.paper_qty ? ` × ${qtyFmt(j.paper_qty)} ${esc(j.paper_unit || '')}` : ''}${j.paper_used != null ? ` (ใช้จริง ${qtyFmt(j.paper_used)})` : ''}` : ''}
          ${j.note ? `<br>📝 ${esc(j.note)}` : ''}
        </div>
      </div>`;
  }

  // ------------------------------------------------------------ views
  const views = {};

  // ---- login
  views.login = {
    render() {
      return `
        <div class="login">
          <div class="logo">📘</div>
          <h1>Print Flow</h1>
          <p>ระบบติดตามงานพิมพ์หนังสือ</p>
          <form id="loginForm">
            <div class="field">
              <label>รหัส PIN ของคุณ</label>
              <input class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" name="pin" maxlength="8" required autofocus>
            </div>
            <button class="btn big" type="submit">เข้าสู่ระบบ</button>
          </form>
        </div>`;
    },
    mount(el) {
      el.querySelector('#loginForm').onsubmit = async (e) => {
        e.preventDefault();
        const pin = e.target.pin.value.trim();
        try {
          const r = await api('POST', '/api/login', { pin });
          S.token = r.token; S.user = r.user;
          localStorage.setItem('pf_token', r.token);
          nativeLogin(r.token);
          location.hash = r.user.role === 'admin' ? '#board' : '#queue';
          await boot();
        } catch (err) { toast(err.message, 'error'); e.target.pin.value = ''; e.target.pin.focus(); }
      };
    },
  };

  // ---- worker queue
  views.queue = {
    async load() {
      const r = await api('GET', '/api/jobs?mine=1&active=1');
      const ids = new Set(r.jobs.filter(j => j.status === 'waiting').map(j => j.id));
      if (S.knownQueueIds) {
        const fresh = [...ids].filter(id => !S.knownQueueIds.has(id));
        if (fresh.length) { beep(); toast(`งานใหม่ ${fresh.length} รายการ`, 'success'); }
      }
      S.knownQueueIds = ids;
      return r;
    },
    render(d) {
      const u = S.user;
      const working = d.jobs.filter(j => j.status === 'working');
      const waiting = d.jobs.filter(j => j.status === 'waiting');
      const sub = roleName(u.role) + (u.machine ? ` · เครื่อง ${u.machine}` : '');
      return shell('งานของฉัน', sub, `
        <div class="section-title">กำลังทำ (${working.length})</div>
        ${working.length ? working.map(j => jobCard(j, { showStage: false })).join('') : '<div class="empty">ยังไม่มีงานที่กำลังทำ</div>'}
        <div class="section-title">รอคิว (${waiting.length})</div>
        ${waiting.length ? waiting.map(j => jobCard(j, { showStage: false })).join('') : '<div class="empty">ไม่มีงานรอคิว 🎉</div>'}
      `);
    },
  };

  // ---- board (all jobs)
  views.board = {
    filter: 'active',
    async load() {
      const [jobs, sum, paper, plates] = await Promise.all([api('GET', '/api/jobs?limit=300'), api('GET', '/api/summary'),
        S.user.role === 'admin' ? api('GET', '/api/paper').catch(() => ({ papers: [] })) : Promise.resolve({ papers: [] }),
        seesPlates() ? api('GET', '/api/plates').catch(() => null) : Promise.resolve(null)]);
      return { jobs: jobs.jobs, sum, papers: paper.papers, plates };
    },
    render(d) {
      const f = views.board.filter;
      const counts = {};
      for (const r of d.sum.rows) counts[r.stage] = (counts[r.stage] || 0) + r.n;
      const activeN = d.sum.rows.reduce((a, r) => a + r.n, 0);
      let list = d.jobs;
      if (f === 'active') list = list.filter(j => j.status === 'waiting' || j.status === 'working');
      else if (f === 'done') list = list.filter(j => j.status === 'done');
      else if (f === 'cancelled') list = list.filter(j => j.status === 'cancelled');
      else list = list.filter(j => j.stage === f && (j.status === 'waiting' || j.status === 'working'));
      const working = d.sum.rows.filter(r => r.status === 'working').reduce((a, r) => a + r.n, 0);
      return shell('ภาพรวมงานพิมพ์', '', `
        <div class="tiles">
          <div class="tile"><div class="n">${activeN}</div><div class="l">งานในสายการผลิต</div></div>
          <div class="tile"><div class="n">${working}</div><div class="l">กำลังทำอยู่</div></div>
          ${S.user.role === 'admin'
            ? `<a class="tile tap" href="#done" style="text-decoration:none;color:inherit;border:2px solid var(--success-soft)"><div class="n" style="color:var(--success)">${d.sum.doneToday}</div><div class="l">เข้าคลังวันนี้ ›</div></a>`
            : `<div class="tile"><div class="n">${d.sum.doneToday}</div><div class="l">เข้าคลังวันนี้</div></div>`}
        </div>
        ${(S.user.role === 'admin' && d.papers.length) || d.plates ? `
        <a class="card tap" href="#paper" style="display:block;text-decoration:none;color:inherit">
          <div class="row between"><div class="title" style="font-size:15px">📦 สต็อกคงเหลือ</div><span class="muted small">ดูทั้งหมด ›</span></div>
          <div class="row wrap" style="margin-top:6px;gap:6px">
            ${d.plates ? `<span class="badge plates-badge">🟧 เพลท <b>${num(d.plates.qty)}</b>${d.plates.min_qty > 0 && d.plates.qty <= d.plates.min_qty ? ' ⚠️' : ''}</span>` : ''}
            ${d.papers.map(p => { const low = p.min_qty > 0 && p.qty <= p.min_qty; return `<span class="badge" style="${low ? 'background:var(--danger-soft);color:var(--danger)' : ''}">${esc(p.name)}: <b>${qtyFmt(p.qty)}</b> ${esc(p.unit)}${low ? ' ⚠️' : ''}</span>`; }).join('')}
          </div>
        </a>` : ''}
        <div class="chips">
          <div class="chip ${f === 'active' ? 'active' : ''}" data-f="active">ทั้งหมด <span class="n">${activeN}</span></div>
          ${S.meta.stages.filter(s => s.key !== 'done').map(s =>
            `<div class="chip ${f === s.key ? 'active' : ''}" data-f="${s.key}">${esc(s.name)} <span class="n">${counts[s.key] || 0}</span></div>`).join('')}
          ${S.user.role === 'admin' ? `<a class="chip" href="#done" style="text-decoration:none;color:inherit">✓ เข้าคลังแล้ว</a>` : `<div class="chip ${f === 'done' ? 'active' : ''}" data-f="done">เสร็จแล้ว</div>`}
          <div class="chip ${f === 'cancelled' ? 'active' : ''}" data-f="cancelled">ยกเลิก</div>
        </div>
        ${list.length ? list.map(j => jobCard(j)).join('') : '<div class="empty">ไม่มีงาน</div>'}
      `);
    },
    mount(el) {
      el.querySelectorAll('.chip[data-f]').forEach(c => c.onclick = () => { views.board.filter = c.dataset.f; render(); });
    },
  };

  // ---- stock: plates (admin + press) and paper (everyone sees; admin manages; workers record usage)
  views.paper = {
    async load() {
      const [p, j, pl] = await Promise.all([
        api('GET', '/api/paper'),
        api('GET', '/api/jobs?active=1&limit=100' + (S.user.role === 'admin' ? '' : '&mine=1')),
        seesPlates() ? api('GET', '/api/plates').catch(() => null) : Promise.resolve(null),
      ]);
      return { papers: p.papers, jobs: j.jobs, plates: pl };
    },
    render(d) {
      const isAdmin = S.user.role === 'admin';
      const low = d.papers.filter(p => p.min_qty > 0 && p.qty <= p.min_qty);
      const pl = d.plates;
      const plLow = pl && pl.min_qty > 0 && pl.qty <= pl.min_qty;
      return shell('สต็อก', `กระดาษ ${d.papers.length} ชนิด${low.length ? ` · ใกล้หมด ${low.length}` : ''}${pl ? ` · เพลท ${num(pl.qty)}` : ''}`, `
        ${pl ? `
        <div class="section-title" style="margin-top:4px">เพลท</div>
        <div class="card stock-plates">
          <div class="row between">
            <div class="grow">
              <div class="title">🟧 เพลทคงเหลือ</div>
              <div class="meta">${pl.min_qty > 0 ? `แจ้งเตือนเมื่อต่ำกว่า ${num(pl.min_qty)} · ` : ''}${pl.updated_at ? `อัปเดต ${ago(pl.updated_at)}` : 'ยังไม่เคยบันทึก'}</div>
            </div>
            <div style="text-align:right">
              <div class="stock-n" style="color:${plLow || pl.qty <= 0 ? 'var(--danger)' : '#c2410c'}">${num(pl.qty)}</div>
              <div class="small muted">เพลท${plLow ? ' · <b style="color:var(--danger)">ใกล้หมด</b>' : ''}</div>
            </div>
          </div>
          <div class="small muted" style="margin-top:6px">หักออกอัตโนมัติตามจำนวนเพลทของงาน เมื่อช่างพิมพ์กด "เริ่มทำ"</div>
          <div class="actions">
            ${isAdmin ? '<button class="btn sm success" id="plateAdd">＋ รับเพลทเข้า</button><button class="btn sm secondary" id="plateAdjust">นับใหม่ / ตั้งค่า</button>' : ''}
            <button class="btn sm ghost" id="plateHist">ประวัติ</button>
          </div>
        </div>
        <div class="section-title">กระดาษ</div>` : ''}
        ${isAdmin ? '<button class="btn" id="addPaper">＋ เพิ่มชนิดกระดาษ</button><div style="height:10px"></div>' : ''}
        ${d.papers.length ? d.papers.map(p => {
          const isLow = p.min_qty > 0 && p.qty <= p.min_qty;
          return `
          <div class="card" data-paper="${p.id}">
            <div class="row between">
              <div class="grow">
                <div class="title">${esc(p.name)}</div>
                <div class="meta">${p.min_qty > 0 ? `ขั้นต่ำ ${qtyFmt(p.min_qty)} ${esc(p.unit)} · ` : ''}${p.note ? esc(p.note) + ' · ' : ''}อัปเดต ${ago(p.updated_at)}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:26px;font-weight:800;color:${isLow ? 'var(--danger)' : p.qty <= 0 ? 'var(--danger)' : 'var(--primary)'}">${qtyFmt(p.qty)}</div>
                <div class="small muted">${esc(p.unit)}${isLow ? ' · <b style="color:var(--danger)">ใกล้หมด</b>' : ''}</div>
              </div>
            </div>
            <div class="actions">
              <button class="btn sm ${isAdmin ? 'secondary' : ''}" data-use="${p.id}">✂️ ใช้กระดาษ</button>
              ${isAdmin ? `<button class="btn sm success" data-add="${p.id}">＋ เพิ่มสต็อก</button><button class="btn sm secondary" data-edit="${p.id}">แก้ไข</button>` : ''}
              <button class="btn sm ghost" data-hist="${p.id}">ประวัติ</button>
            </div>
          </div>`; }).join('') : `<div class="empty">ยังไม่มีข้อมูลกระดาษ${isAdmin ? '<br>กดเพิ่มชนิดกระดาษ' : ''}</div>`}
      `);
    },
    mount(el, d) {
      const byId = (id) => d.papers.find(p => p.id === Number(id));
      el.querySelector('#addPaper')?.addEventListener('click', () => paperForm(null));
      el.querySelector('#plateAdd')?.addEventListener('click', () => plateAddSheet(d.plates));
      el.querySelector('#plateAdjust')?.addEventListener('click', () => plateAdjustSheet(d.plates));
      el.querySelector('#plateHist')?.addEventListener('click', () => plateHistory(d.plates));
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => paperForm(byId(b.dataset.edit)));
      el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => paperAddSheet(byId(b.dataset.add)));
      el.querySelectorAll('[data-use]').forEach(b => b.onclick = () => paperUseSheet(byId(b.dataset.use), d.jobs, null));
      el.querySelectorAll('[data-hist]').forEach(b => b.onclick = () => paperHistory(byId(b.dataset.hist)));
    },
  };

  function paperForm(paper) {
    openSheet(`
      <h2>${paper ? 'แก้ไขกระดาษ' : 'เพิ่มชนิดกระดาษ'}</h2>
      <form id="paperForm">
        <div class="field"><label>ชื่อ / ชนิด / ขนาด *</label><input name="name" required placeholder="เช่น ปอนด์ 80 แกรม 24x35 นิ้ว" value="${esc(paper?.name)}"></div>
        <div class="grid2">
          <div class="field"><label>หน่วยนับ</label><input name="unit" placeholder="รีม / แผ่น / ห่อ" value="${esc(paper?.unit ?? 'รีม')}"></div>
          <div class="field"><label>แจ้งเตือนเมื่อเหลือไม่ถึง</label><input name="min_qty" type="number" inputmode="decimal" step="any" min="0" value="${esc(paper?.min_qty ?? 0)}"></div>
        </div>
        ${paper ? `
        <div class="field"><label>นับสต็อกใหม่ (จำนวนที่มีจริงตอนนี้) — เว้นว่างถ้าไม่เปลี่ยน</label><input name="recount" type="number" inputmode="decimal" step="any" min="0" placeholder="ปัจจุบัน ${qtyFmt(paper.qty)} ${esc(paper.unit)}"></div>
        ` : `
        <div class="field"><label>จำนวนเริ่มต้น</label><input name="qty" type="number" inputmode="decimal" step="any" min="0" value="0"></div>`}
        <div class="field"><label>หมายเหตุ</label><input name="note" value="${esc(paper?.note)}"></div>
        <div class="actions">
          ${paper ? '<button type="button" class="btn danger" id="delPaper">ลบ</button>' : ''}
          <button class="btn" type="submit">บันทึก</button>
        </div>
      </form>`, (el) => {
      el.querySelector('#paperForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        try {
          if (paper) {
            await api('PUT', `/api/paper/${paper.id}`, fd);
            if (fd.recount !== '' && fd.recount !== undefined) await api('POST', `/api/paper/${paper.id}/adjust`, { qty: fd.recount, note: 'นับสต็อก' });
          } else await api('POST', '/api/paper', fd);
          closeSheet(); toast('บันทึกแล้ว', 'success'); render(true);
        } catch (err) { toast(err.message, 'error'); }
      };
      el.querySelector('#delPaper')?.addEventListener('click', async () => {
        if (!(await confirmSheet('ลบกระดาษ', `เอา "${esc(paper.name)}" ออกจากรายการ? ประวัติยังอยู่`, 'ลบ', 'danger'))) return;
        try { await api('PUT', `/api/paper/${paper.id}`, { ...paper, active: false }); toast('ลบแล้ว'); render(true); } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  function paperAddSheet(paper) {
    openSheet(`
      <h2>＋ เพิ่มสต็อก: ${esc(paper.name)}</h2>
      <p class="muted small">คงเหลือตอนนี้ ${qtyFmt(paper.qty)} ${esc(paper.unit)}</p>
      <form id="addForm">
        <div class="field"><label>จำนวนที่รับเข้า (${esc(paper.unit)}) *</label><input name="amount" type="number" inputmode="decimal" step="any" min="0.01" required autofocus class="pin-input" style="letter-spacing:0"></div>
        <div class="field"><label>หมายเหตุ (เช่น ใบส่งของ / ร้านที่ซื้อ)</label><input name="note"></div>
        <button class="btn big success" type="submit">บันทึกรับเข้า</button>
      </form>`, (el) => {
      el.querySelector('#addForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        try { const r = await api('POST', `/api/paper/${paper.id}/add`, fd); closeSheet(); toast(`รับเข้าแล้ว เหลือ ${qtyFmt(r.qty_after)} ${paper.unit}`, 'success'); render(true); }
        catch (err) { toast(err.message, 'error'); }
      };
    });
  }

  function paperUseSheet(paper, jobs, presetJob) {
    const active = (jobs || []).filter(j => j.status === 'working' || j.status === 'waiting');
    const options = active.map(j => `<option value="${j.id}" ${presetJob && presetJob.id === j.id ? 'selected' : (!presetJob && j.status === 'working' && j.worker_name === S.user.name ? 'selected' : '')}>#${j.id} ${esc(j.book_title)} (${esc(j.color)}, ${num(j.quantity)} เล่ม)</option>`).join('');
    openSheet(`
      <h2>✂️ ใช้กระดาษ: ${esc(paper.name)}</h2>
      <p class="muted small">คงเหลือตอนนี้ <b>${qtyFmt(paper.qty)} ${esc(paper.unit)}</b></p>
      <form id="useForm">
        <div class="field"><label>จำนวนที่ใช้ (${esc(paper.unit)}) *</label><input name="amount" type="number" inputmode="decimal" step="any" min="0.01" required autofocus class="pin-input" style="letter-spacing:0"></div>
        <div class="field"><label>ใช้กับงาน</label>
          <select name="job_id"><option value="">— ไม่ระบุ —</option>${options}</select></div>
        <div class="field"><label>หมายเหตุ</label><input name="note" placeholder="เช่น เผื่อเสีย 20 แผ่น"></div>
        <button class="btn big" type="submit">บันทึกการใช้</button>
      </form>`, (el) => {
      el.querySelector('#useForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        if (Number(fd.amount) > paper.qty && !(await confirmSheet('กระดาษไม่พอ', `ในระบบเหลือ ${qtyFmt(paper.qty)} ${esc(paper.unit)} แต่จะใช้ ${qtyFmt(fd.amount)} — บันทึกต่อไหม? (ยอดจะติดลบ ให้ผู้ดูแลนับสต็อกใหม่)`, 'บันทึก', 'danger'))) return;
        try { const r = await api('POST', `/api/paper/${paper.id}/use`, fd); closeSheet(); toast(`บันทึกแล้ว เหลือ ${qtyFmt(r.qty_after)} ${paper.unit}`, 'success'); render(true); }
        catch (err) { toast(err.message, 'error'); }
      };
    });
  }

  async function paperHistory(paper) {
    let d;
    try { d = await api('GET', `/api/paper/${paper.id}/moves`); } catch (err) { return toast(err.message, 'error'); }
    const typeName = { in: '📥 รับเข้า', use: '✂️ ใช้', adjust: '📝 นับสต็อก' };
    openSheet(`
      <h2>ประวัติ: ${esc(paper.name)}</h2>
      <p class="muted small">คงเหลือ ${qtyFmt(paper.qty)} ${esc(paper.unit)} · แสดง ${d.moves.length} รายการล่าสุด</p>
      <ul class="timeline">
        ${d.moves.map(m => `<li><b>${typeName[m.type] || m.type}</b> ${m.delta > 0 ? '+' : ''}${qtyFmt(m.delta)} ${esc(paper.unit)} → เหลือ ${qtyFmt(m.qty_after)}
          ${m.job_title ? `<div class="small">งาน #${m.job_id} ${esc(m.job_title)}</div>` : ''}${m.note ? `<div class="small">📝 ${esc(m.note)}</div>` : ''}
          <div class="when">${esc(m.user_name || '')} · ${fmtTime(m.created_at)}</div></li>`).join('') || '<li class="muted">ยังไม่มีรายการ</li>'}
      </ul>`);
  }

  // ---- plate stock sheets (admin)
  function plateAddSheet(pl) {
    openSheet(`
      <h2>＋ รับเพลทเข้า</h2>
      <p class="muted small">คงเหลือตอนนี้ <b>${num(pl.qty)} เพลท</b></p>
      <form id="plAdd">
        <div class="field"><label>จำนวนที่รับเข้า (เพลท) *</label><input name="amount" type="number" inputmode="numeric" min="1" required autofocus class="pin-input" style="letter-spacing:0"></div>
        <div class="field"><label>หมายเหตุ (เช่น ใบส่งของ / ร้านที่ซื้อ)</label><input name="note"></div>
        <button class="btn big success" type="submit">บันทึกรับเข้า</button>
      </form>`, (el) => {
      el.querySelector('#plAdd').onsubmit = async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        try { const r = await api('POST', '/api/plates/add', fd); closeSheet(); toast(`รับเข้าแล้ว เหลือ ${num(r.qty_after)} เพลท`, 'success'); render(true); }
        catch (err) { toast(err.message, 'error'); }
      };
    });
  }
  function plateAdjustSheet(pl) {
    openSheet(`
      <h2>นับเพลทใหม่ / ตั้งค่า</h2>
      <form id="plAdj">
        <div class="field"><label>จำนวนที่มีจริงตอนนี้ (เพลท) — เว้นว่างถ้าไม่เปลี่ยน</label><input name="qty" type="number" inputmode="numeric" min="0" placeholder="ปัจจุบัน ${num(pl.qty)}"></div>
        <div class="field"><label>แจ้งเตือนผู้ดูแลเมื่อเหลือไม่ถึง (เพลท)</label><input name="min_qty" type="number" inputmode="numeric" min="0" value="${esc(pl.min_qty ?? 0)}"></div>
        <div class="field"><label>หมายเหตุ</label><input name="note" placeholder="เช่น นับสต็อกสิ้นเดือน"></div>
        <button class="btn big" type="submit">บันทึก</button>
      </form>`, (el) => {
      el.querySelector('#plAdj').onsubmit = async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        try { await api('POST', '/api/plates/adjust', fd); closeSheet(); toast('บันทึกแล้ว', 'success'); render(true); }
        catch (err) { toast(err.message, 'error'); }
      };
    });
  }
  function plateHistory(pl) {
    const typeName = { in: '📥 รับเข้า', use: '🖨️ ใช้กับงาน', adjust: '📝 นับสต็อก' };
    openSheet(`
      <h2>ประวัติเพลท</h2>
      <p class="muted small">คงเหลือ ${num(pl.qty)} เพลท · แสดง ${pl.moves.length} รายการล่าสุด</p>
      <ul class="timeline">
        ${pl.moves.map(m => `<li><b>${typeName[m.type] || m.type}</b> ${m.delta > 0 ? '+' : ''}${num(m.delta)} เพลท → เหลือ ${num(m.qty_after)}
          ${m.job_title ? `<div class="small">งาน #${m.job_id} ${esc(m.job_title)}</div>` : ''}${m.note ? `<div class="small">📝 ${esc(m.note)}</div>` : ''}
          <div class="when">${esc(m.user_name || '')} · ${fmtTime(m.created_at)}</div></li>`).join('') || '<li class="muted">ยังไม่มีรายการ</li>'}
      </ul>`);
  }

  // ---- daily log (admin): everything that happened on one day, Bangkok time
  const bkkToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const shiftDay = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const thDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('th-TH', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  views.log = {
    date: null,
    async load() { views.log.date ||= bkkToday(); return api('GET', '/api/log?date=' + views.log.date); },
    render(d) {
      const s = d.summary;
      const isToday = d.date === bkkToday();
      const typeName = { in: 'รับเข้า', use: 'ใช้', adjust: 'นับสต็อก' };
      const line = (it) => {
        const t = parseDate(it.at)?.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) || '';
        if (it.kind === 'job') {
          const ic = { created: '🧺', start: '▶️', finish: '✅', cancel: '🚫' }[it.type] || '•';
          const unit = it.plates ? (stageIndex(it.stage) <= stageIndex('print') ? ` · <b>${num(it.plates)} เพลท</b>` : ` · <b>${yokFmt(it.yok)} ยก</b>`) : '';
          return `<li data-job="${it.job_id}" class="tap"><span class="t">${t}</span> ${ic} <b>${EV_NAME[it.type] || it.type}</b> · ${esc(stageName(it.stage))}${it.machine ? ` (เครื่อง ${esc(it.machine)})` : ''}
            <div>${esc(it.book_title || '')} · ${num(it.quantity)} เล่ม (${esc(it.color)})${unit}</div>
            ${it.note ? `<div class="small">📝 ${esc(it.note)}</div>` : ''}<div class="when">${esc(it.user_name || '')} · งาน #${it.job_id}</div></li>`;
        }
        if (it.kind === 'paper') return `<li><span class="t">${t}</span> 📄 <b>กระดาษ ${typeName[it.type] || it.type}</b> · ${esc(it.paper_name)} ${it.delta > 0 ? '+' : ''}${qtyFmt(it.delta)} ${esc(it.unit)} → เหลือ ${qtyFmt(it.qty_after)}${it.note ? `<div class="small">📝 ${esc(it.note)}</div>` : ''}<div class="when">${esc(it.user_name || '')}${it.job_id ? ` · งาน #${it.job_id}` : ''}</div></li>`;
        return `<li><span class="t">${t}</span> 🟧 <b>เพลท ${typeName[it.type] || it.type}</b> ${it.delta > 0 ? '+' : ''}${num(it.delta)} → เหลือ ${num(it.qty_after)}${it.note ? `<div class="small">📝 ${esc(it.note)}</div>` : ''}<div class="when">${esc(it.user_name || '')}${it.job_id ? ` · งาน #${it.job_id}` : ''}</div></li>`;
      };
      return shell('บันทึกประจำวัน', thDate(d.date), `
        <div class="row" style="margin-bottom:10px">
          <button class="btn sm secondary" id="logPrev">‹</button>
          <input type="date" id="logDate" class="sel grow" value="${d.date}" max="${bkkToday()}">
          <button class="btn sm secondary" id="logNext" ${isToday ? 'disabled' : ''}>›</button>
          ${isToday ? '' : '<button class="btn sm ghost" id="logToday">วันนี้</button>'}
        </div>
        <div class="tiles">
          <div class="tile"><div class="n">${s.created}</div><div class="l">ส่งงานเข้า</div></div>
          <div class="tile"><div class="n">${s.printed}</div><div class="l">พิมพ์เสร็จ</div></div>
          <div class="tile"><div class="n" style="color:var(--success)">${s.done}</div><div class="l">เข้าคลัง · ${num(s.doneBooks)} เล่ม</div></div>
          <div class="tile"><div class="n" style="color:#c2410c">${num(s.platesUsed)}</div><div class="l">เพลทที่ใช้</div></div>
          <div class="tile"><div class="n">${s.byStage.cut || 0}</div><div class="l">ตัดกระดาษเสร็จ</div></div>
          <div class="tile"><div class="n">${(s.byStage.fold || 0) + (s.byStage.bind || 0)}</div><div class="l">พับ + เก็บเล่มเสร็จ</div></div>
        </div>
        ${s.paperUsed.length ? `<div class="card"><div class="title" style="font-size:15px">📄 กระดาษที่ใช้</div><div class="row wrap" style="margin-top:6px;gap:6px">${s.paperUsed.map(p => `<span class="badge">${esc(p.name)}: <b>${qtyFmt(p.qty)}</b> ${esc(p.unit)}</span>`).join('')}</div></div>` : ''}
        <div class="section-title">เหตุการณ์ (${d.items.length})</div>
        ${d.items.length ? `<ul class="timeline log">${d.items.map(line).join('')}</ul>` : '<div class="empty">ไม่มีเหตุการณ์ในวันนี้</div>'}
      `);
    },
    mount(el, d) {
      const go = (date) => { views.log.date = date; render(true); };
      el.querySelector('#logPrev').onclick = () => go(shiftDay(d.date, -1));
      el.querySelector('#logNext').onclick = () => go(shiftDay(d.date, 1));
      el.querySelector('#logToday')?.addEventListener('click', () => go(bkkToday()));
      el.querySelector('#logDate').onchange = (e) => { if (e.target.value) go(e.target.value); };
    },
  };

  // ---- completed books (admin): everything that reached the warehouse
  views.done = {
    q: '',
    async load() { return api('GET', '/api/jobs?status=done&limit=1000'); },
    render(d) {
      const q = views.done.q.toLowerCase();
      const list = d.jobs.filter(j => !q || j.book_title.toLowerCase().includes(q) || (j.book_code || '').toLowerCase().includes(q));
      const dayKey = (s) => { const dt = parseDate(s); return dt ? dt.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }) : '-'; };
      const todayKey = dayKey(new Date().toISOString());
      const weekAgo = Date.now() - 7 * 86400e3;
      const today = d.jobs.filter(j => dayKey(j.finished_at) === todayKey);
      const week = d.jobs.filter(j => (parseDate(j.finished_at)?.getTime() || 0) >= weekAgo);
      const sumQty = (arr) => arr.reduce((a, j) => a + Number(j.quantity || 0), 0);
      const groups = [];
      for (const j of list) {
        const k = dayKey(j.finished_at);
        let g = groups[groups.length - 1];
        if (!g || g.key !== k) { g = { key: k, jobs: [] }; groups.push(g); }
        g.jobs.push(j);
      }
      return shell('เข้าคลังแล้ว', `${d.jobs.length} รายการทั้งหมด`, `
        <div class="tiles">
          <div class="tile"><div class="n">${today.length}</div><div class="l">วันนี้ · ${num(sumQty(today))} เล่ม</div></div>
          <div class="tile"><div class="n">${week.length}</div><div class="l">7 วัน · ${num(sumQty(week))} เล่ม</div></div>
          <div class="tile"><div class="n">${num(sumQty(d.jobs))}</div><div class="l">เล่มทั้งหมด</div></div>
        </div>
        <input class="search" id="doneSearch" placeholder="ค้นหาชื่อหรือรหัสหนังสือ" value="${esc(views.done.q)}">
        ${groups.length ? groups.map(g => `
          <div class="section-title row between"><span>${esc(g.key)}</span><span>${g.jobs.length} รายการ · ${num(sumQty(g.jobs))} เล่ม</span></div>
          ${g.jobs.map(j => `
            <div class="card tap" data-job="${j.id}">
              <div class="row between">
                <div class="title">${esc(j.book_title)}</div>
                <span class="badge done">✓ เข้าคลัง</span>
              </div>
              <div class="row wrap" style="margin-top:6px">
                <span class="badge color">${esc(j.color)}</span>
                <span class="badge">${num(j.quantity)} เล่ม</span>
                ${unitChip(j)}
                ${j.machine ? `<span class="badge">เครื่อง ${esc(j.machine)}</span>` : ''}
              </div>
              <div class="meta">${j.book_code ? `รหัส ${esc(j.book_code)} · ` : ''}#${j.id} · เสร็จ ${fmtTime(j.finished_at)} · เริ่ม ${fmtTime(j.created_at)}</div>
            </div>`).join('')}`).join('') : '<div class="empty">ยังไม่มีหนังสือที่เข้าคลัง</div>'}
      `);
    },
    mount(el) {
      const search = el.querySelector('#doneSearch');
      search.oninput = () => { views.done.q = search.value; const pos = search.selectionStart; render(true); const s2 = document.getElementById('doneSearch'); s2.focus(); s2.setSelectionRange(pos, pos); };
    },
  };

  // ---- books (admin)
  views.books = {
    q: '',
    async load() { return api('GET', '/api/books'); },
    render(d) {
      const q = views.books.q.toLowerCase();
      const list = d.books.filter(b => !q || b.title.toLowerCase().includes(q) || (b.code || '').toLowerCase().includes(q));
      return shell('หนังสือ', `${d.books.length} รายการ`, `
        <input class="search" id="bookSearch" placeholder="ค้นหาชื่อหรือรหัสหนังสือ" value="${esc(views.books.q)}">
        <button class="btn" id="addBook">＋ เพิ่มหนังสือใหม่</button>
        <div style="height:10px"></div>
        ${list.map(b => `
          <div class="card" data-book="${b.id}">
            <div class="row between">
              <div>
                <div class="title">${esc(b.title)}</div>
                <div class="meta">${b.code ? `รหัส ${esc(b.code)} · ` : ''}${b.pages ? `${b.pages} หน้า · ` : ''}${b.plates ? `${num(b.plates)} เพลท (${yokFmt(yokOf(b.plates))} ยก) · ` : ''}ปกติ ${num(b.default_qty)} เล่ม${b.note ? ` · ${esc(b.note)}` : ''}</div>
              </div>
              <span class="badge color">${esc(b.color)}</span>
            </div>
            <div class="actions">
              <button class="btn secondary sm" data-edit="${b.id}">แก้ไข</button>
              <button class="btn sm" data-add="${b.id}">🧺 ใส่ตะกร้า</button>
            </div>
          </div>`).join('') || '<div class="empty">ยังไม่มีหนังสือ กดเพิ่มหนังสือใหม่</div>'}
      `);
    },
    mount(el, d) {
      const search = el.querySelector('#bookSearch');
      search.oninput = () => { views.books.q = search.value; const pos = search.selectionStart; render(); const s2 = document.getElementById('bookSearch'); s2.focus(); s2.setSelectionRange(pos, pos); };
      el.querySelector('#addBook').onclick = () => bookForm(null);
      el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => bookForm(d.books.find(x => x.id === Number(b.dataset.edit))));
      el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
        const book = d.books.find(x => x.id === Number(b.dataset.add));
        S.basket.push({ book_id: book.id, title: book.title, quantity: book.default_qty, color: book.color, plates: book.plates ?? null, note: '' });
        saveBasket();
        toast(`ใส่ "${book.title}" ลงตะกร้าแล้ว`, 'success');
        render();
      });
    },
  };

  function bookForm(book) {
    const colors = S.meta.colors;
    openSheet(`
      <h2>${book ? 'แก้ไขหนังสือ' : 'เพิ่มหนังสือใหม่'}</h2>
      <form id="bookForm">
        <div class="field"><label>ชื่อหนังสือ *</label><input name="title" required value="${esc(book?.title)}"></div>
        <div class="grid2">
          <div class="field"><label>รหัส / ISBN</label><input name="code" value="${esc(book?.code)}"></div>
          <div class="field"><label>จำนวนหน้า</label><input name="pages" type="number" inputmode="numeric" value="${esc(book?.pages)}"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>เครื่องพิมพ์ (จำนวนสี)</label>
            <select name="color">${colors.map(c => `<option ${book?.color === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          <div class="field"><label>จำนวนพิมพ์ปกติ (เล่ม)</label><input name="default_qty" type="number" inputmode="numeric" value="${esc(book?.default_qty ?? 1000)}"></div>
        </div>
        <div class="field"><label>จำนวนเพลทปกติ (${platesPerYok()} เพลท = 1 ยก) — เปลี่ยนได้ตอนส่งงาน</label>
          <input name="plates" id="bookPP" type="number" inputmode="numeric" min="0" placeholder="เช่น 16" value="${esc(book?.plates)}">
          <div class="small muted" id="bookPPHint" style="margin-top:4px">${book?.plates ? `= ${yokFmt(yokOf(book.plates))} ยก` : ''}</div></div>
        <div class="field"><label>หมายเหตุ</label><textarea name="note">${esc(book?.note)}</textarea></div>
        <div class="actions">
          ${book ? '<button type="button" class="btn danger" id="delBook">ลบ</button>' : ''}
          <button class="btn" type="submit">บันทึก</button>
        </div>
      </form>`, (el) => {
      const pp = el.querySelector('#bookPP');
      pp.oninput = () => { el.querySelector('#bookPPHint').textContent = pp.value > 0 ? `= ${yokFmt(yokOf(pp.value))} ยก` : ''; };
      el.querySelector('#bookForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        try {
          if (book) await api('PUT', `/api/books/${book.id}`, fd); else await api('POST', '/api/books', fd);
          closeSheet(); toast('บันทึกแล้ว', 'success'); render(true);
        } catch (err) { toast(err.message, 'error'); }
      };
      el.querySelector('#delBook')?.addEventListener('click', async () => {
        if (!(await confirmSheet('ลบหนังสือ', `ลบ "${esc(book.title)}" ออกจากรายการ? ประวัติงานเก่ายังอยู่`, 'ลบ', 'danger'))) return;
        try { await api('DELETE', `/api/books/${book.id}`); toast('ลบแล้ว'); render(true); } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  // ---- basket (admin)
  views.basket = {
    async load() {
      const [p, pl] = await Promise.all([api('GET', '/api/paper').catch(() => ({ papers: [] })), api('GET', '/api/plates').catch(() => null)]);
      return { papers: p.papers, plates: pl };
    },
    render(d) {
      const papers = d?.papers || [];
      const paperOpts = (sel) => `<option value="">— ไม่ระบุกระดาษ —</option>` + papers.map(p => `<option value="${p.id}" ${Number(sel) === p.id ? 'selected' : ''}>${esc(p.name)} (เหลือ ${qtyFmt(p.qty)} ${esc(p.unit)})</option>`).join('');
      const total = S.basket.reduce((a, b) => a + Number(b.quantity || 0), 0);
      const totalPlates = S.basket.reduce((a, b) => a + (Number(b.plates) || 0), 0);
      const pl = d?.plates;
      return shell('ตะกร้างานพิมพ์', `${S.basket.length} รายการ · ${num(total)} เล่ม${totalPlates ? ` · ${num(totalPlates)} เพลท` : ''}`, `
        ${S.basket.length === 0 ? '<div class="empty">ตะกร้าว่าง<br><a href="#books">ไปเลือกหนังสือ</a></div>' : ''}
        ${S.basket.map((it, i) => `
          <div class="card">
            <div class="row between">
              <div class="title">${esc(it.title)}</div>
              <button class="btn ghost sm" data-rm="${i}">✕</button>
            </div>
            <div class="row" style="margin-top:8px">
              <label class="small muted">จำนวน</label>
              <input class="qty" type="number" inputmode="numeric" min="1" data-qty="${i}" value="${esc(it.quantity)}"> <span class="small muted">เล่ม</span>
              <span class="grow"></span>
              <select class="sel" data-color="${i}">${S.meta.colors.map(c => `<option ${it.color === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
            </div>
            <div class="row" style="margin-top:8px">
              <label class="small muted">เพลท</label>
              <input class="qty" type="number" inputmode="numeric" min="0" placeholder="เช่น 16" data-pp="${i}" value="${esc(it.plates ?? '')}">
              <span class="small muted">${it.plates > 0 ? `= <b>${yokFmt(yokOf(it.plates))} ยก</b> (ช่างหลังแท่นพิมพ์จะเห็นเป็นยก)` : `ไม่ระบุ · ${platesPerYok()} เพลท = 1 ยก`}</span>
            </div>
            <div class="row" style="margin-top:8px">
              <select class="sel grow" data-paper="${i}">${paperOpts(it.paper_id)}</select>
              <input class="qty" type="number" inputmode="decimal" step="any" min="0" placeholder="จำนวน" data-pqty="${i}" value="${esc(it.paper_qty ?? '')}">
              <span class="small muted">${esc(papers.find(p => p.id === Number(it.paper_id))?.unit || '')}</span>
            </div>
            ${(() => { const pp = papers.find(p => p.id === Number(it.paper_id)); return pp && Number(it.paper_qty) > pp.qty ? `<div class="small" style="color:var(--danger);margin-top:4px">⚠️ กระดาษในสต็อกเหลือ ${qtyFmt(pp.qty)} ${esc(pp.unit)} ไม่พอตามแผน</div>` : ''; })()}
            <input class="note-line" placeholder="หมายเหตุถึงช่าง (ถ้ามี)" data-note="${i}" value="${esc(it.note)}">
          </div>`).join('')}
        ${S.basket.length && pl && totalPlates ? (totalPlates > pl.qty
          ? `<div class="card" style="background:var(--danger-soft);color:var(--danger)">⚠️ งานในตะกร้าต้องใช้ <b>${num(totalPlates)} เพลท</b> แต่สต็อกเหลือ <b>${num(pl.qty)}</b> — ส่งงานได้ แต่ควรรับเพลทเข้าก่อนถึงคิวพิมพ์</div>`
          : `<div class="small muted" style="margin:4px 0 8px">🟧 ใช้ ${num(totalPlates)} เพลท จากสต็อก ${num(pl.qty)} (จะเหลือ ${num(pl.qty - totalPlates)})</div>`) : ''}
        ${S.basket.length ? `
          <div class="field" style="margin-top:14px"><label>หมายเหตุรวมของออเดอร์นี้</label><input id="orderNote" placeholder="เช่น ด่วน ส่งลูกค้าศุกร์นี้"></div>
          <button class="btn big success" id="submitOrder">🚀 ส่งงานเข้าสายการผลิต</button>
          <div style="height:8px"></div>
          <button class="btn ghost" id="clearBasket">ล้างตะกร้า</button>` : ''}
      `);
    },
    mount(el, d) {
      views.basket._papers = d?.papers || [];
      el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { S.basket.splice(Number(b.dataset.rm), 1); saveBasket(); render(); });
      el.querySelectorAll('[data-qty]').forEach(i => i.onchange = () => { S.basket[Number(i.dataset.qty)].quantity = Math.max(1, Number(i.value) || 1); saveBasket(); });
      el.querySelectorAll('[data-color]').forEach(s => s.onchange = () => { S.basket[Number(s.dataset.color)].color = s.value; saveBasket(); });
      el.querySelectorAll('[data-pp]').forEach(i => i.onchange = () => { const n = Math.round(Number(i.value)); S.basket[Number(i.dataset.pp)].plates = n > 0 ? n : null; saveBasket(); render(true); });
      el.querySelectorAll('[data-note]').forEach(i => i.onchange = () => { S.basket[Number(i.dataset.note)].note = i.value; saveBasket(); });
      el.querySelectorAll('[data-paper]').forEach(s2 => s2.onchange = () => { S.basket[Number(s2.dataset.paper)].paper_id = s2.value ? Number(s2.value) : null; saveBasket(); render(true); });
      el.querySelectorAll('[data-pqty]').forEach(i => i.onchange = () => { S.basket[Number(i.dataset.pqty)].paper_qty = i.value === '' ? null : Math.max(0, Number(i.value) || 0); saveBasket(); render(true); });
      el.querySelector('#clearBasket')?.addEventListener('click', async () => {
        if (await confirmSheet('ล้างตะกร้า', 'เอาทุกรายการออกจากตะกร้า?', 'ล้าง', 'danger')) { S.basket = []; saveBasket(); render(); }
      });
      el.querySelector('#submitOrder')?.addEventListener('click', async () => {
        const papers = S.cache.papers || [];
        const lines = S.basket.map(b => { const pp = (views.basket._papers || []).find(p => p.id === Number(b.paper_id)); return `• ${esc(b.title)} — ${num(b.quantity)} เล่ม (${esc(b.color)})${b.plates > 0 ? ` · ${num(b.plates)} เพลท = ${yokFmt(yokOf(b.plates))} ยก` : ''}${pp ? `<br>&nbsp;&nbsp;📄 ${esc(pp.name)}${b.paper_qty ? ` × ${qtyFmt(b.paper_qty)} ${esc(pp.unit)}` : ''}` : ''}`; }).join('<br>');
        if (!(await confirmSheet('ยืนยันส่งงาน', `${lines}<br><br>งานจะไปที่แผนก <b>ตัดกระดาษ</b> ก่อน และช่างจะได้รับการแจ้งเตือน`, 'ส่งงาน'))) return;
        try {
          const note = document.getElementById('orderNote')?.value || '';
          const r = await api('POST', '/api/orders', { items: S.basket, note });
          S.basket = []; saveBasket();
          toast(`ส่งงาน ${r.jobs.length} รายการแล้ว`, 'success');
          location.hash = '#board';
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  };

  // ---- users (admin)
  views.users = {
    async load() { return api('GET', '/api/users'); },
    render(d) {
      const groups = {};
      for (const u of d.users) (groups[u.role] ||= []).push(u);
      return shell('พนักงาน', `${d.users.filter(u => u.active).length} คน`, `
        <div class="actions" style="margin-top:0">
          <button class="btn" id="addUser">＋ เพิ่มพนักงาน</button>
          <a class="btn secondary" href="#qrcards" style="text-align:center;text-decoration:none">🪪 บัตร QR</a>
        </div>
        ${Object.keys(S.meta.roles).filter(r => groups[r]).map(r => `
          <div class="section-title">${esc(roleName(r))}</div>
          ${groups[r].map(u => `
            <div class="card tap" data-user="${u.id}" style="${u.active ? '' : 'opacity:.5'}">
              <div class="row between">
                <div><div class="title">${esc(u.name)}</div>
                  <div class="meta">${u.machine ? `เครื่อง ${esc(u.machine)} · ` : ''}PIN ${esc(u.pin)}${u.active ? '' : ' · ปิดใช้งาน'}</div></div>
                <span class="muted">›</span>
              </div>
            </div>`).join('')}`).join('')}
      `);
    },
    mount(el, d) {
      el.querySelector('#addUser').onclick = () => userForm(null);
      el.querySelectorAll('[data-user]').forEach(c => c.onclick = () => userForm(d.users.find(u => u.id === Number(c.dataset.user))));
    },
  };

  function userForm(user) {
    openSheet(`
      <h2>${user ? 'แก้ไขพนักงาน' : 'เพิ่มพนักงาน'}</h2>
      <form id="userForm">
        <div class="field"><label>ชื่อ *</label><input name="name" required value="${esc(user?.name)}"></div>
        <div class="field"><label>แผนก *</label>
          <select name="role" id="roleSel">${Object.entries(S.meta.roles).map(([k, v]) => `<option value="${k}" ${user?.role === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
        <div class="field" id="machineField" style="display:${user?.role === 'printer' ? 'block' : 'none'}"><label>เครื่องพิมพ์ *</label>
          <select name="machine">${S.meta.machines.map(m => `<option value="${m.key}" ${user?.machine === m.key ? 'selected' : ''}>${m.key}</option>`).join('')}</select></div>
        <div class="field"><label>รหัส PIN (ตัวเลข 4-8 หลัก) *</label><input name="pin" inputmode="numeric" pattern="[0-9]{4,8}" required value="${esc(user?.pin)}"></div>
        ${user ? `<div class="field"><label><input type="checkbox" name="active" ${user.active ? 'checked' : ''}> ใช้งานอยู่</label></div>` : ''}
        <div class="actions">
          ${user && user.id !== S.user.id ? '<button type="button" class="btn danger" id="delUser">ลบ</button>' : ''}
          <button class="btn" type="submit">บันทึก</button>
        </div>
      </form>`, (el) => {
      const roleSel = el.querySelector('#roleSel');
      roleSel.onchange = () => { el.querySelector('#machineField').style.display = roleSel.value === 'printer' ? 'block' : 'none'; };
      el.querySelector('#userForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        if (user) fd.active = e.target.active.checked;
        try {
          if (user) await api('PUT', `/api/users/${user.id}`, fd); else await api('POST', '/api/users', fd);
          closeSheet(); toast('บันทึกแล้ว', 'success'); render(true);
        } catch (err) { toast(err.message, 'error'); }
      };
      el.querySelector('#delUser')?.addEventListener('click', async () => {
        if (!(await confirmSheet('ลบพนักงาน', `ลบ "${esc(user.name)}"? จะเข้าสู่ระบบไม่ได้อีก`, 'ลบ', 'danger'))) return;
        try { await api('DELETE', `/api/users/${user.id}`); closeSheet(); toast('ลบแล้ว'); render(true); } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  // ---- QR login cards (admin)
  views.qrcards = {
    async load() {
      const appLink = location.origin + location.pathname.replace(/[^/]*$/, '');
      const res = await fetch(API + '/api/qr-cards?url=' + encodeURIComponent(appLink), { headers: { Authorization: 'Bearer ' + S.token } });
      if (!res.ok) { let e = {}; try { e = await res.json(); } catch { /* empty */ } throw new Error(e.error || 'โหลดบัตรไม่ได้'); }
      return { html: await res.text() };
    },
    render(d) {
      return shell('บัตร QR เข้าใช้งาน', 'สแกนเพื่อเปิดแอป · PIN อยู่บนบัตร', `
        <div class="actions" style="margin:0 0 10px">
          <a class="btn secondary" href="#users" style="text-align:center;text-decoration:none">‹ กลับ</a>
          <button class="btn" id="printCards">🖨️ พิมพ์ / บันทึก PDF</button>
        </div>
        <iframe id="cardsFrame" style="width:100%;height:calc(100vh - 210px);border:0;border-radius:var(--radius);background:#fff"></iframe>
      `);
    },
    mount(el, d) {
      const frame = el.querySelector('#cardsFrame');
      frame.srcdoc = d.html;
      el.querySelector('#printCards').onclick = () => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); }
        catch { toast('พิมพ์ไม่ได้ในเบราว์เซอร์นี้', 'error'); }
      };
    },
  };

  // ---- settings
  views.settings = {
    async load() {
      let perm = 'unsupported', subscribed = false;
      if ('Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window) {
        perm = Notification.permission;
        try { const reg = await navigator.serviceWorker.ready; S.pushSub = await reg.pushManager.getSubscription(); subscribed = !!S.pushSub; } catch { /* ignore */ }
      }
      return { perm, subscribed, secure: window.isSecureContext };
    },
    render(d) {
      const u = S.user;
      let notif;
      if (NATIVE) notif = '<div class="small" style="color:var(--success)">✅ แอป Android: แจ้งเตือนแบบนาฬิกาปลุกเปิดอยู่ (ดังจนกว่าจะกดรับทราบ แม้ปิดแอป)</div><div class="small muted" style="margin-top:6px">ถ้าไม่ดัง: ตั้งค่าโทรศัพท์ → แอป → Print Flow → แบตเตอรี่ → ไม่จำกัด และอนุญาต "การแจ้งเตือนเต็มหน้าจอ"</div>';
      else if (!d.secure) notif = '<div class="muted small">⚠️ การแจ้งเตือนต้องเปิดผ่าน HTTPS (หรือ localhost) เท่านั้น</div>';
      else if (d.perm === 'unsupported' && /iPhone|iPad/.test(navigator.userAgent) && !window.navigator.standalone)
        notif = '<div class="muted small">📱 บน iPhone ต้องติดตั้งก่อนถึงจะแจ้งเตือนได้:<br>1. กดปุ่ม <b>แชร์</b> (สี่เหลี่ยมมีลูกศร) ด้านล่าง<br>2. เลือก <b>เพิ่มลงในหน้าจอโฮม</b><br>3. ปิด Safari แล้วเปิดแอปจากไอคอนบนหน้าจอโฮม<br>4. กลับมาหน้านี้แล้วกดเปิดการแจ้งเตือน</div>';
      else if (d.perm === 'unsupported') notif = '<div class="muted small">เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน ลองใช้ Chrome บน Android</div>';
      else if (d.perm === 'denied') notif = '<div class="muted small">❌ คุณปิดการแจ้งเตือนไว้ เปิดได้ที่ การตั้งค่าเบราว์เซอร์ → การแจ้งเตือน</div>';
      else if (d.subscribed) notif = `<div class="small" style="color:var(--success)">✅ เปิดการแจ้งเตือนบนเครื่องนี้แล้ว</div>
          <div class="actions"><button class="btn secondary sm" id="testPush">ส่งทดสอบ</button><button class="btn ghost sm" id="disablePush">ปิดการแจ้งเตือน</button></div>`;
      else notif = `<div class="muted small">ยังไม่ได้เปิด — เปิดเพื่อรับแจ้งเตือนเมื่อมีงานใหม่ แม้ปิดแอปอยู่</div>
          <div class="actions"><button class="btn" id="enablePush">🔔 เปิดการแจ้งเตือน</button></div>`;
      return shell('ตั้งค่า', '', `
        <div class="card">
          <div class="title">${esc(u.name)}</div>
          <div class="meta">${esc(roleName(u.role))}${u.machine ? ` · เครื่อง ${esc(u.machine)}` : ''}</div>
        </div>
        <div class="section-title">การแจ้งเตือน</div>
        <div class="card">${notif}</div>
        <div class="section-title">เสียงเตือน</div>
        <div class="card">
          <div class="row between">
            <div><div class="title" style="font-size:16px">🏭 โหมดสถานี</div>
              <div class="small muted">วางเครื่องไว้ที่แท่น: หน้าจอไม่ดับ รีเฟรชทุก 3 วิ และไซเรนดังจนกว่าจะกดรับทราบ</div></div>
            <label class="switch"><input type="checkbox" id="stationToggle" ${stationOn() ? 'checked' : ''}><span></span></label>
          </div>
          <div class="small" style="margin-top:10px">เมื่อมีงานใหม่ขณะเปิดแอปอยู่ จะมีเสียงไซเรน + สั่น + จอแดงกระพริบ จนกว่าจะกด <b>รับทราบ</b></div>
          <div class="actions"><button class="btn secondary sm" id="testAlarm">🚨 ทดสอบเสียงไซเรน</button></div>
          <div class="small muted" style="margin-top:10px">⚠️ ถ้า<b>ปิดแอป</b>อยู่ ระบบจะส่งแจ้งเตือน 4 ครั้ง ห่างกัน 15 วินาที
            — Android เล่นเสียงแจ้งเตือนได้แค่ครั้งละ 1 รอบ ดังนั้นให้ตั้ง<b>เสียงแจ้งเตือนของแอปเป็นเสียงเรียกเข้าแบบยาว</b> จะได้ดังต่อเนื่องเกือบ 1-2 นาที</div>
          <div class="small muted" style="margin-top:10px"><b>ทำให้แจ้งเตือนดังเหมือนนาฬิกาปลุก (Android):</b><br>
            1. ติดตั้งแอปลงหน้าจอหลักก่อน<br>
            2. กดค้างที่ไอคอน Print Flow → <b>ข้อมูลแอป</b> → <b>การแจ้งเตือน</b><br>
            3. เลือกหมวดการแจ้งเตือน → ระดับ <b>เร่งด่วน / แสดงเด้งขึ้นและมีเสียง</b><br>
            4. <b>เสียง</b> → เลือกเสียงนาฬิกาปลุกหรือเสียงเรียกเข้าที่ดังที่สุด<br>
            5. ปิด <b>ห้ามรบกวน</b> และตั้ง <b>แบตเตอรี่</b> ของแอป/Chrome เป็น "ไม่จำกัด"<br>
            6. ถ้าไม่มีใครกดเริ่มภายใน 3 นาที ระบบจะเตือนซ้ำทุก 2 นาที (สูงสุด 6 ครั้ง)</div>
        </div>
        ${NATIVE ? '' : '<div class="section-title">ติดตั้งเป็นแอป</div>'}
        ${NATIVE ? '' : `<div class="card small muted"><b>Android (แนะนำ):</b> <a href="./print-flow.apk">ดาวน์โหลดแอป Print Flow (.apk)</a> แล้วเปิดไฟล์เพื่อติดตั้ง (ถ้าถามให้อนุญาตติดตั้งจากแหล่งนี้)<br><b>Android (ไม่ติดตั้ง APK):</b> เปิดใน Chrome → เมนู ⋮ → <b>เพิ่มลงในหน้าจอหลัก</b> / <b>ติดตั้งแอป</b><br><b>iPhone:</b> เปิดใน Safari → ปุ่ม <b>แชร์</b> → <b>เพิ่มลงในหน้าจอโฮม</b><br>จากนั้นเปิดจากไอคอนบนหน้าจอหลักทุกครั้ง</div>`}
        <div style="height:16px"></div>
        <button class="btn danger" id="logout">ออกจากระบบ</button>
        <div class="center muted small">Print Flow v0.1</div>
      `);
    },
    mount(el) {
      el.querySelector('#enablePush')?.addEventListener('click', enablePush);
      el.querySelector('#disablePush')?.addEventListener('click', disablePush);
      el.querySelector('#testPush')?.addEventListener('click', async () => { await api('POST', '/api/push/test'); toast('ส่งแล้ว รอสักครู่…'); });
      el.querySelector('#testAlarm')?.addEventListener('click', () => startAlarm('ทดสอบเสียงไซเรน', 'แบบนี้คือเสียงตอนมีงานใหม่ กดรับทราบเพื่อหยุด'));
      el.querySelector('#stationToggle')?.addEventListener('change', async (e) => { await setStation(e.target.checked); toast(e.target.checked ? 'เปิดโหมดสถานีแล้ว หน้าจอจะไม่ดับขณะเปิดแอป' : 'ปิดโหมดสถานีแล้ว'); });
      el.querySelector('#logout').onclick = async () => {
        if (!(await confirmSheet('ออกจากระบบ', 'เครื่องนี้จะไม่ได้รับการแจ้งเตือนจนกว่าจะเข้าสู่ระบบใหม่', 'ออกจากระบบ', 'danger'))) return;
        try { await api('POST', '/api/logout', { endpoint: S.pushSub?.endpoint }); } catch { /* ignore */ }
        try { await S.pushSub?.unsubscribe(); } catch { /* ignore */ }
        logoutLocal();
      };
    },
  };

  // ---- job detail (sheet)
  async function openJob(id) {
    let d;
    try { d = await api('GET', `/api/jobs/${id}`); } catch (err) { return toast(err.message, 'error'); }
    const j = d.job;
    const idx = stageIndex(j.stage);
    const can = canWork(j);
    const isAdmin = S.user.role === 'admin';
    const flow = S.meta.stages.map((s, i) => {
      const cls = j.status === 'done' ? 'past' : i < idx ? 'past' : i === idx ? 'now' : '';
      return `<div class="step ${cls}"><div class="num">${i < idx || j.status === 'done' ? '✓' : i + 1}</div>${esc(s.name)}</div>`;
    }).join('<span class="arrow">›</span>');
    const evName = EV_NAME;
    openSheet(`
      <div class="row between"><h2>${esc(j.book_title)}</h2><span class="badge ${j.status}">${statusName[j.status]}</span></div>
      <div class="row wrap" style="margin-bottom:6px">
        <span class="badge color">${esc(j.color)}</span><span class="badge">${num(j.quantity)} เล่ม</span>
        ${j.book_code ? `<span class="badge">รหัส ${esc(j.book_code)}</span>` : ''}
        ${j.machine ? `<span class="badge">เครื่อง ${esc(j.machine)}</span>` : ''}<span class="badge">งาน #${j.id}</span>
      </div>
      ${unitChip(j, true)}
      ${j.note ? `<div class="card" style="background:var(--warn-soft);color:var(--warn)">📝 ${esc(j.note)}</div>` : ''}
      ${j.paper_name ? `<div class="card" style="background:var(--primary-soft)"><b>📄 กระดาษ:</b> ${esc(j.paper_name)}${j.paper_qty ? ` × <b>${qtyFmt(j.paper_qty)} ${esc(j.paper_unit || '')}</b>` : ''}${j.paper_used != null ? `<div class="small">ใช้จริง ${qtyFmt(j.paper_used)} ${esc(j.paper_unit || '')} (ตัดสต็อกแล้ว)</div>` : ''}</div>` : ''}
      <div class="flow">${flow}</div>
      ${can && j.status === 'waiting' ? `<button class="btn big" id="startJob">▶️ เริ่มทำ${esc(stageName(j.stage))}</button>` : ''}
      ${can && j.status === 'working' ? `
        ${j.paper_id && j.paper_used == null ? `<div class="field"><label>📄 กระดาษที่ใช้จริง (${esc(j.paper_unit || '')}) — ระบบจะตัดสต็อกตามนี้</label><input id="finishPaper" type="number" inputmode="decimal" step="any" min="0" value="${j.stage === 'cut' && j.paper_qty ? esc(j.paper_qty) : ''}" placeholder="${j.stage === 'cut' ? 'เว้นว่าง = ใช้ตามแผน' : 'เว้นว่าง = ยังไม่ตัดสต็อก'}"></div>` : ''}
        <div class="field"><label>หมายเหตุ (ถ้ามี)</label><input id="finishNote" placeholder="เช่น เสียกระดาษ 20 แผ่น"></div>
        <button class="btn big success" id="finishJob">✅ เสร็จแล้ว ส่งต่อ${idx + 1 < S.meta.stages.length - 1 ? 'ไป' + esc(S.meta.stages[idx + 1].name) : 'เข้าคลัง'}</button>` : ''}
      ${can && j.status === 'working' ? '<div style="height:8px"></div><button class="btn secondary" id="usePaperJob">📄 บันทึกกระดาษที่ใช้กับงานนี้</button>' : ''}
      ${j.status === 'working' && !can && j.worker_name ? `<div class="muted small">กำลังทำโดย ${esc(j.worker_name)}</div>` : ''}
      <div class="section-title">ประวัติ</div>
      <ul class="timeline">
        ${d.events.map(e => `<li><b>${evName[e.type] || e.type}</b> · ${esc(stageName(e.stage))}${e.machine ? ` (เครื่อง ${esc(e.machine)})` : ''}
          ${e.note ? `<div>📝 ${esc(e.note)}</div>` : ''}
          <div class="when">${esc(e.user_name || '')} · ${fmtTime(e.created_at)}</div></li>`).join('')}
      </ul>
      ${isAdmin && (j.status === 'waiting' || j.status === 'working') ? '<div style="height:10px"></div><button class="btn danger" id="cancelJob">ยกเลิกงานนี้</button>' : ''}
    `, (el) => {
      el.querySelector('#startJob')?.addEventListener('click', async () => {
        try { await api('POST', `/api/jobs/${j.id}/start`); closeSheet(); toast('เริ่มงานแล้ว', 'success'); render(true); }
        catch (err) { toast(err.message, 'error'); }
      });
      el.querySelector('#finishJob')?.addEventListener('click', async () => {
        const next = S.meta.stages[idx + 1];
        const msg = next && next.key !== 'done' ? `งานจะถูกส่งไปที่ <b>${esc(next.name)}</b> และช่างจะได้รับแจ้งเตือน` : 'งานจะถูกบันทึกว่าเข้าคลังแล้ว';
        if (!(await confirmSheet('ยืนยันว่าเสร็จแล้ว', msg, 'ยืนยัน'))) return;
        try {
          const pu = document.getElementById('finishPaper')?.value;
          await api('POST', `/api/jobs/${j.id}/finish`, { note: document.getElementById('finishNote')?.value || '', ...(pu !== undefined ? { paper_used: pu } : {}) });
          toast('ส่งต่อแล้ว 👍', 'success'); render(true);
        } catch (err) { toast(err.message, 'error'); }
      });
      el.querySelector('#usePaperJob')?.addEventListener('click', async () => {
        try {
          const p = await api('GET', '/api/paper');
          if (!p.papers.length) return toast('ยังไม่มีข้อมูลกระดาษ ให้ผู้ดูแลเพิ่มก่อน', 'error');
          openSheet(`<h2>เลือกชนิดกระดาษ</h2>${p.papers.map(pp => `<div class="card tap" data-pick="${pp.id}"><div class="row between"><div class="title">${esc(pp.name)}</div><div><b>${qtyFmt(pp.qty)}</b> <span class="small muted">${esc(pp.unit)}</span></div></div></div>`).join('')}`,
            (el2) => el2.querySelectorAll('[data-pick]').forEach(c => c.onclick = () => paperUseSheet(p.papers.find(x => x.id === Number(c.dataset.pick)), [j], j)));
        } catch (err) { toast(err.message, 'error'); }
      });
      el.querySelector('#cancelJob')?.addEventListener('click', async () => {
        if (!(await confirmSheet('ยกเลิกงาน', `ยกเลิก "${esc(j.book_title)}" ${num(j.quantity)} เล่ม?`, 'ยกเลิกงาน', 'danger'))) return;
        try { await api('POST', `/api/jobs/${j.id}/cancel`); toast('ยกเลิกแล้ว'); render(true); } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  function canWork(job) {
    const u = S.user;
    if (u.role === 'admin') return true;
    const stage = S.meta.stages.find(s => s.key === job.stage);
    if (!stage || stage.role !== u.role) return false;
    if (u.role === 'printer') {
      const color = S.meta.machines.find(m => m.key === u.machine)?.color;
      return color === job.color;
    }
    return true;
  }

  // ------------------------------------------------------------ push
  function urlB64ToU8(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('ไม่ได้รับอนุญาตให้แจ้งเตือน', 'error');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(S.meta.pushKey) });
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      S.pushSub = sub;
      toast('เปิดการแจ้งเตือนแล้ว 🔔', 'success');
      render(true);
    } catch (err) { console.error(err); toast('เปิดการแจ้งเตือนไม่สำเร็จ: ' + err.message, 'error'); }
  }

  async function disablePush() {
    try {
      if (S.pushSub) { await api('POST', '/api/push/unsubscribe', { endpoint: S.pushSub.endpoint }); await S.pushSub.unsubscribe(); S.pushSub = null; }
      toast('ปิดการแจ้งเตือนแล้ว'); render(true);
    } catch (err) { toast(err.message, 'error'); }
  }

  // Re-register an existing subscription after login (e.g. new device user)
  async function syncPush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { S.pushSub = sub; await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() }); }
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ render loop
  let renderSeq = 0;
  async function render(force = false) {
    if (!S.user) {
      $app.innerHTML = views.login.render();
      views.login.mount($app);
      return;
    }
    const hash = currentHash();
    const [name, arg] = hash.split('/');
    if (name === 'job' && arg) { openJob(arg); return; }
    let view = views[name] || views[S.user.role === 'admin' ? 'board' : 'queue'];
    if (S.user.role !== 'admin' && ['books', 'basket', 'users', 'qrcards', 'done', 'log'].includes(name)) view = views.queue;
    const seq = ++renderSeq;
    S.view = view;
    try {
      const data = view.load ? await view.load() : null;
      if (seq !== renderSeq) return; // a newer render started
      // keep scroll position on refresh
      const y = window.scrollY;
      const focused = document.activeElement;
      if (!force && focused && focused.tagName === 'INPUT' && $app.contains(focused) && !['books', 'done'].includes(name)) return; // don't clobber typing
      $app.innerHTML = view.render(data);
      view.mount?.($app, data);
      $app.querySelectorAll('[data-job]').forEach(c => c.onclick = () => openJob(c.dataset.job));
      window.scrollTo(0, y);
    } catch (err) {
      if (!S.user) return render();
      toast(err.message, 'error');
    }
  }

  // ---------------------------------------------------------- station mode
  // For a phone/tablet left on a stand at the machine: screen stays on, queue refreshes every 3 s,
  // and the siren runs until acknowledged.
  const stationOn = () => localStorage.getItem('pf_station') === '1';
  let wakeLock = null;
  async function holdWakeLock() {
    try {
      if (!stationOn() || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not allowed on this device */ }
  }
  async function releaseWakeLock() { try { await wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
  async function setStation(on) {
    localStorage.setItem('pf_station', on ? '1' : '0');
    if (on) { getAudio(); await holdWakeLock(); } else await releaseWakeLock();
    startPolling();
  }

  function startPolling() {
    clearInterval(S.pollTimer);
    S.pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if ($sheet.children.length) return;           // don't refresh under an open sheet
      if (['queue', 'board'].includes(currentHash().split('/')[0])) render();
    }, stationOn() ? 3000 : 8000);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { holdWakeLock(); render(); } });

  function logoutLocal() {
    nativeLogout();
    S.token = null; S.user = null; S.knownQueueIds = null;
    localStorage.removeItem('pf_token');
    clearInterval(S.pollTimer);
    location.hash = '';
    render();
  }

  async function boot() {
    if (!S.meta) S.meta = await api('GET', '/api/meta');
    if (S.token && !S.user) {
      try { S.user = (await api('GET', '/api/me')).user; } catch { S.user = null; }
    }
    if (S.user) { syncPush(); startPolling(); holdWakeLock(); nativeLogin(S.token); }
    render();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('sw failed', err));
  }
  boot().catch(err => { $app.innerHTML = `<div class="center">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้<br><span class="muted small">${esc(err.message)}</span></div>`; });
})();
