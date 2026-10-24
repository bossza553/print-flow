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
      const tone = (f, t, d) => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.9, t); g.gain.setValueAtTime(0, t + d); o.connect(g); g.connect(master); o.start(t); o.stop(t + d + 0.02); };
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
    ov.querySelector('#alarmOk').onclick = () => { stopAlarm(); location.hash = S.user?.role === 'admin' ? '#board' : '#queue'; render(true); };
    setTimeout(stopAlarm, 20000);
  }
  function stopAlarm() {
    alarm?.stop(); alarm = null;
    if (navigator.vibrate) navigator.vibrate(0);
    document.getElementById('alarmOverlay')?.remove();
  }
  function beep() { startAlarm('งานใหม่มาถึงแล้ว!', 'แตะรับทราบ แล้วกดเริ่มทำงานในคิว'); }

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
    { hash: 'users', label: 'พนักงาน', ic: '👷' },
    { hash: 'settings', label: 'ตั้งค่า', ic: '⚙️' },
  ];
  const WORKER_TABS = [
    { hash: 'queue', label: 'งานของฉัน', ic: '🛠️' },
    { hash: 'board', label: 'ภาพรวม', ic: '📋' },
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
        <div class="row wrap" style="margin-top:6px">
          <span class="badge color">${esc(j.color)}</span>
          <span class="badge">${num(j.quantity)} เล่ม</span>
          ${showStage ? `<span class="badge">${esc(stageName(j.stage))}</span>` : ''}
          ${j.machine ? `<span class="badge">เครื่อง ${esc(j.machine)}</span>` : ''}
        </div>
        <div class="meta">
          ${j.book_code ? `รหัส ${esc(j.book_code)} · ` : ''}#${j.id} · ${ago(j.updated_at)}
          ${j.worker_name ? ` · ${esc(j.worker_name)}` : ''}
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
      const [jobs, sum] = await Promise.all([api('GET', '/api/jobs?limit=300'), api('GET', '/api/summary')]);
      return { jobs: jobs.jobs, sum };
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
          <div class="tile"><div class="n">${d.sum.doneToday}</div><div class="l">เข้าคลังวันนี้</div></div>
        </div>
        <div class="chips">
          <div class="chip ${f === 'active' ? 'active' : ''}" data-f="active">ทั้งหมด <span class="n">${activeN}</span></div>
          ${S.meta.stages.filter(s => s.key !== 'done').map(s =>
            `<div class="chip ${f === s.key ? 'active' : ''}" data-f="${s.key}">${esc(s.name)} <span class="n">${counts[s.key] || 0}</span></div>`).join('')}
          <div class="chip ${f === 'done' ? 'active' : ''}" data-f="done">เสร็จแล้ว</div>
          <div class="chip ${f === 'cancelled' ? 'active' : ''}" data-f="cancelled">ยกเลิก</div>
        </div>
        ${list.length ? list.map(j => jobCard(j)).join('') : '<div class="empty">ไม่มีงาน</div>'}
      `);
    },
    mount(el) {
      el.querySelectorAll('.chip[data-f]').forEach(c => c.onclick = () => { views.board.filter = c.dataset.f; render(); });
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
                <div class="meta">${b.code ? `รหัส ${esc(b.code)} · ` : ''}${b.pages ? `${b.pages} หน้า · ` : ''}ปกติ ${num(b.default_qty)} เล่ม${b.note ? ` · ${esc(b.note)}` : ''}</div>
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
        S.basket.push({ book_id: book.id, title: book.title, quantity: book.default_qty, color: book.color, note: '' });
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
        <div class="field"><label>หมายเหตุ</label><textarea name="note">${esc(book?.note)}</textarea></div>
        <div class="actions">
          ${book ? '<button type="button" class="btn danger" id="delBook">ลบ</button>' : ''}
          <button class="btn" type="submit">บันทึก</button>
        </div>
      </form>`, (el) => {
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
    render() {
      const total = S.basket.reduce((a, b) => a + Number(b.quantity || 0), 0);
      return shell('ตะกร้างานพิมพ์', `${S.basket.length} รายการ · ${num(total)} เล่ม`, `
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
            <input class="note-line" placeholder="หมายเหตุถึงช่าง (ถ้ามี)" data-note="${i}" value="${esc(it.note)}">
          </div>`).join('')}
        ${S.basket.length ? `
          <div class="field" style="margin-top:14px"><label>หมายเหตุรวมของออเดอร์นี้</label><input id="orderNote" placeholder="เช่น ด่วน ส่งลูกค้าศุกร์นี้"></div>
          <button class="btn big success" id="submitOrder">🚀 ส่งงานเข้าสายการผลิต</button>
          <div style="height:8px"></div>
          <button class="btn ghost" id="clearBasket">ล้างตะกร้า</button>` : ''}
      `);
    },
    mount(el) {
      el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { S.basket.splice(Number(b.dataset.rm), 1); saveBasket(); render(); });
      el.querySelectorAll('[data-qty]').forEach(i => i.onchange = () => { S.basket[Number(i.dataset.qty)].quantity = Math.max(1, Number(i.value) || 1); saveBasket(); });
      el.querySelectorAll('[data-color]').forEach(s => s.onchange = () => { S.basket[Number(s.dataset.color)].color = s.value; saveBasket(); });
      el.querySelectorAll('[data-note]').forEach(i => i.onchange = () => { S.basket[Number(i.dataset.note)].note = i.value; saveBasket(); });
      el.querySelector('#clearBasket')?.addEventListener('click', async () => {
        if (await confirmSheet('ล้างตะกร้า', 'เอาทุกรายการออกจากตะกร้า?', 'ล้าง', 'danger')) { S.basket = []; saveBasket(); render(); }
      });
      el.querySelector('#submitOrder')?.addEventListener('click', async () => {
        const lines = S.basket.map(b => `• ${esc(b.title)} — ${num(b.quantity)} เล่ม (${esc(b.color)})`).join('<br>');
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
      if (!d.secure) notif = '<div class="muted small">⚠️ การแจ้งเตือนต้องเปิดผ่าน HTTPS (หรือ localhost) เท่านั้น</div>';
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
          <div class="small">เมื่อมีงานใหม่ขณะเปิดแอปอยู่ จะมีเสียงไซเรน + สั่นจนกว่าจะกดรับทราบ</div>
          <div class="actions"><button class="btn secondary sm" id="testAlarm">🚨 ทดสอบเสียงไซเรน</button></div>
          <div class="small muted" style="margin-top:10px"><b>ทำให้แจ้งเตือนดังเหมือนนาฬิกาปลุก (Android):</b><br>
            1. ติดตั้งแอปลงหน้าจอหลักก่อน<br>
            2. กดค้างที่ไอคอน Print Flow → <b>ข้อมูลแอป</b> → <b>การแจ้งเตือน</b><br>
            3. เลือกหมวดการแจ้งเตือน → ระดับ <b>เร่งด่วน / แสดงเด้งขึ้นและมีเสียง</b><br>
            4. <b>เสียง</b> → เลือกเสียงนาฬิกาปลุกหรือเสียงเรียกเข้าที่ดังที่สุด<br>
            5. ปิด <b>ห้ามรบกวน</b> และตั้ง <b>แบตเตอรี่</b> ของแอป/Chrome เป็น "ไม่จำกัด"<br>
            6. ถ้าไม่มีใครกดเริ่มภายใน 3 นาที ระบบจะเตือนซ้ำทุก 2 นาที (สูงสุด 6 ครั้ง)</div>
        </div>
        <div class="section-title">ติดตั้งเป็นแอป</div>
        <div class="card small muted"><b>Android (แนะนำ):</b> <a href="https://github.com/bossza553/print-flow/releases/latest/download/print-flow.apk">ดาวน์โหลดแอป Print Flow (.apk)</a> แล้วเปิดไฟล์เพื่อติดตั้ง (ถ้าถามให้อนุญาตติดตั้งจากแหล่งนี้)<br><b>Android (ไม่ติดตั้ง APK):</b> เปิดใน Chrome → เมนู ⋮ → <b>เพิ่มลงในหน้าจอหลัก</b> / <b>ติดตั้งแอป</b><br><b>iPhone:</b> เปิดใน Safari → ปุ่ม <b>แชร์</b> → <b>เพิ่มลงในหน้าจอโฮม</b><br>จากนั้นเปิดจากไอคอนบนหน้าจอหลักทุกครั้ง</div>
        <div style="height:16px"></div>
        <button class="btn danger" id="logout">ออกจากระบบ</button>
        <div class="center muted small">Print Flow v0.1</div>
      `);
    },
    mount(el) {
      el.querySelector('#enablePush')?.addEventListener('click', enablePush);
      el.querySelector('#disablePush')?.addEventListener('click', disablePush);
      el.querySelector('#testPush')?.addEventListener('click', async () => { await api('POST', '/api/push/test'); toast('ส่งแล้ว รอสักครู่…'); });
      el.querySelector('#testAlarm')?.addEventListener('click', () => startAlarm('ทดสอบเสียงไซเรน', 'แบบนี้คือเสียงตอนมีงานใหม่'));
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
    const evName = { created: 'ส่งงานเข้าสายการผลิต', start: 'เริ่มทำ', finish: 'ทำเสร็จ ส่งต่อ', cancel: 'ยกเลิกงาน' };
    openSheet(`
      <div class="row between"><h2>${esc(j.book_title)}</h2><span class="badge ${j.status}">${statusName[j.status]}</span></div>
      <div class="row wrap" style="margin-bottom:10px">
        <span class="badge color">${esc(j.color)}</span><span class="badge">${num(j.quantity)} เล่ม</span>
        ${j.book_code ? `<span class="badge">รหัส ${esc(j.book_code)}</span>` : ''}
        ${j.machine ? `<span class="badge">เครื่อง ${esc(j.machine)}</span>` : ''}<span class="badge">งาน #${j.id}</span>
      </div>
      ${j.note ? `<div class="card" style="background:var(--warn-soft);color:var(--warn)">📝 ${esc(j.note)}</div>` : ''}
      <div class="flow">${flow}</div>
      ${can && j.status === 'waiting' ? `<button class="btn big" id="startJob">▶️ เริ่มทำ${esc(stageName(j.stage))}</button>` : ''}
      ${can && j.status === 'working' ? `
        <div class="field"><label>หมายเหตุ (ถ้ามี)</label><input id="finishNote" placeholder="เช่น เสียกระดาษ 20 แผ่น"></div>
        <button class="btn big success" id="finishJob">✅ เสร็จแล้ว ส่งต่อ${idx + 1 < S.meta.stages.length - 1 ? 'ไป' + esc(S.meta.stages[idx + 1].name) : 'เข้าคลัง'}</button>` : ''}
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
          await api('POST', `/api/jobs/${j.id}/finish`, { note: document.getElementById('finishNote')?.value || '' });
          toast('ส่งต่อแล้ว 👍', 'success'); render(true);
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
    if (S.user.role !== 'admin' && ['books', 'basket', 'users', 'qrcards'].includes(name)) view = views.queue;
    const seq = ++renderSeq;
    S.view = view;
    try {
      const data = view.load ? await view.load() : null;
      if (seq !== renderSeq) return; // a newer render started
      // keep scroll position on refresh
      const y = window.scrollY;
      const focused = document.activeElement;
      if (!force && focused && focused.tagName === 'INPUT' && $app.contains(focused) && name !== 'books') return; // don't clobber typing
      $app.innerHTML = view.render(data);
      view.mount?.($app, data);
      $app.querySelectorAll('[data-job]').forEach(c => c.onclick = () => openJob(c.dataset.job));
      window.scrollTo(0, y);
    } catch (err) {
      if (!S.user) return render();
      toast(err.message, 'error');
    }
  }

  function startPolling() {
    clearInterval(S.pollTimer);
    S.pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if ($sheet.children.length) return;           // don't refresh under an open sheet
      if (['queue', 'board'].includes(currentHash().split('/')[0])) render();
    }, 8000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
  }

  function logoutLocal() {
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
    if (S.user) { syncPush(); startPolling(); }
    render();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('sw failed', err));
  }
  boot().catch(err => { $app.innerHTML = `<div class="center">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้<br><span class="muted small">${esc(err.message)}</span></div>`; });
})();
