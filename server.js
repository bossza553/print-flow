import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, newToken } from './lib/db.js';
import { STAGES, ROLES, COLORS, MACHINES, stageByKey, nextStage, machineColor, canWork } from './lib/workflow.js';
import * as push from './lib/push.js';
import { renderQrCards } from './lib/qrcards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid JSON'); }
}

function auth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.name, u.role, u.machine FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND u.active = 1
  `).get(token) || null;
}

function requireUser(req) {
  const u = auth(req);
  if (!u) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  return u;
}

function requireAdmin(req) {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new HttpError(403, 'เฉพาะผู้ดูแลระบบเท่านั้น');
  return u;
}

const JOB_SELECT = `
  SELECT j.*, b.title AS book_title, b.code AS book_code, b.pages AS book_pages,
         w.name AS worker_name
  FROM jobs j
  JOIN books b ON b.id = j.book_id
  LEFT JOIN users w ON w.id = j.worker_id
`;

function getJob(id) {
  const job = db.prepare(JOB_SELECT + ' WHERE j.id = ?').get(id);
  if (!job) throw new HttpError(404, 'ไม่พบงาน');
  return job;
}

function addEvent(jobId, type, stage, userId, machine, note) {
  db.prepare('INSERT INTO job_events (job_id, type, stage, user_id, machine, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(jobId, type, stage, userId ?? null, machine ?? null, note ?? null);
}

/** Users who should be notified when a job lands in `stageKey` */
function usersForStage(stageKey, color) {
  const stage = stageByKey(stageKey);
  if (!stage?.role) return [];
  const rows = db.prepare('SELECT id, role, machine FROM users WHERE active = 1 AND role = ?').all(stage.role);
  return rows
    .filter(u => u.role !== 'printer' || machineColor(u.machine) === color)
    .map(u => u.id);
}

function adminIds() {
  return db.prepare("SELECT id FROM users WHERE active = 1 AND role = 'admin'").all().map(r => r.id);
}

function notify(userIds, title, body, url = '/') {
  push.notifyUsers(userIds, { title, body, url, ts: Date.now() }).catch(() => {});
}

// ---------------------------------------------------------------- routes
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

// --- meta
route('GET', '/api/meta', () => ({ stages: STAGES, roles: ROLES, colors: COLORS, machines: MACHINES, pushKey: push.publicKey }));

// --- auth
route('POST', '/api/login', async (req) => {
  const { pin } = await readJson(req);
  if (!pin) throw new HttpError(400, 'กรุณาใส่รหัส PIN');
  const user = db.prepare('SELECT id, name, role, machine FROM users WHERE pin = ? AND active = 1').get(String(pin));
  if (!user) throw new HttpError(401, 'รหัส PIN ไม่ถูกต้อง');
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  return { token, user };
});

route('GET', '/api/me', (req) => ({ user: requireUser(req) }));

route('POST', '/api/logout', async (req) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const { endpoint } = await readJson(req).catch(() => ({}));
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  if (endpoint) push.removeSubscription(endpoint);
  return { ok: true };
});

// --- users (admin)
route('GET', '/api/users', (req) => {
  requireAdmin(req);
  return { users: db.prepare('SELECT id, name, role, machine, pin, active, created_at FROM users ORDER BY role, id').all() };
});

function validateUser(body) {
  const name = String(body.name || '').trim();
  const role = String(body.role || '');
  const pin = String(body.pin || '').trim();
  const machine = role === 'printer' ? String(body.machine || '') : null;
  if (!name) throw new HttpError(400, 'กรุณาใส่ชื่อ');
  if (!ROLES[role]) throw new HttpError(400, 'ตำแหน่งไม่ถูกต้อง');
  if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'PIN ต้องเป็นตัวเลข 4-8 หลัก');
  if (role === 'printer' && !MACHINES.some(m => m.key === machine)) throw new HttpError(400, 'กรุณาเลือกเครื่องพิมพ์');
  return { name, role, pin, machine };
}

route('POST', '/api/users', async (req) => {
  requireAdmin(req);
  const u = validateUser(await readJson(req));
  try {
    const r = db.prepare('INSERT INTO users (name, role, machine, pin) VALUES (?, ?, ?, ?)').run(u.name, u.role, u.machine, u.pin);
    return { id: Number(r.lastInsertRowid) };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'PIN นี้ถูกใช้แล้ว');
    throw e;
  }
});

route('PUT', '/api/users/:id', async (req, p) => {
  const me = requireAdmin(req);
  const body = await readJson(req);
  const u = validateUser(body);
  const active = body.active === undefined ? 1 : (body.active ? 1 : 0);
  if (Number(p.id) === me.id && !active) throw new HttpError(400, 'ปิดใช้งานตัวเองไม่ได้');
  try {
    db.prepare('UPDATE users SET name = ?, role = ?, machine = ?, pin = ?, active = ? WHERE id = ?')
      .run(u.name, u.role, u.machine, u.pin, active, p.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'PIN นี้ถูกใช้แล้ว');
    throw e;
  }
  return { ok: true };
});

// Printable login cards (QR + PIN) for all active users. Admin only.
// The client passes its own origin so the QR points at whatever link the admin is using.
route('GET', '/api/qr-cards', async (req) => {
  requireAdmin(req);
  const url = new URL(req.url, 'http://x').searchParams.get('url') || '';
  if (!/^https?:\/\/[^\s"'<>]+$/.test(url)) throw new HttpError(400, 'invalid url');
  return { __html: await renderQrCards(url) };
});

route('DELETE', '/api/users/:id', (req, p) => {
  const me = requireAdmin(req);
  if (Number(p.id) === me.id) throw new HttpError(400, 'ลบตัวเองไม่ได้');
  // soft delete keeps history intact
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(p.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(p.id);
  return { ok: true };
});

// --- books
route('GET', '/api/books', (req) => {
  requireUser(req);
  return { books: db.prepare('SELECT * FROM books WHERE active = 1 ORDER BY title').all() };
});

function validateBook(body) {
  const title = String(body.title || '').trim();
  if (!title) throw new HttpError(400, 'กรุณาใส่ชื่อหนังสือ');
  const color = String(body.color || '4สี');
  if (!COLORS.includes(color)) throw new HttpError(400, 'จำนวนสีไม่ถูกต้อง');
  const pages = body.pages ? Number(body.pages) : null;
  const default_qty = Math.max(1, Number(body.default_qty) || 1000);
  return { title, code: String(body.code || '').trim() || null, pages, color, default_qty, note: String(body.note || '').trim() || null };
}

route('POST', '/api/books', async (req) => {
  requireAdmin(req);
  const b = validateBook(await readJson(req));
  const r = db.prepare('INSERT INTO books (title, code, pages, color, default_qty, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.title, b.code, b.pages, b.color, b.default_qty, b.note);
  return { id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/books/:id', async (req, p) => {
  requireAdmin(req);
  const b = validateBook(await readJson(req));
  db.prepare('UPDATE books SET title = ?, code = ?, pages = ?, color = ?, default_qty = ?, note = ? WHERE id = ?')
    .run(b.title, b.code, b.pages, b.color, b.default_qty, b.note, p.id);
  return { ok: true };
});

route('DELETE', '/api/books/:id', (req, p) => {
  requireAdmin(req);
  db.prepare('UPDATE books SET active = 0 WHERE id = ?').run(p.id);
  return { ok: true };
});

// --- orders: admin submits the basket -> one job per basket line
route('POST', '/api/orders', async (req) => {
  const me = requireAdmin(req);
  const body = await readJson(req);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) throw new HttpError(400, 'ตะกร้าว่าง');

  const getBook = db.prepare('SELECT * FROM books WHERE id = ? AND active = 1');
  const insOrder = db.prepare('INSERT INTO orders (created_by, note) VALUES (?, ?)');
  const insJob = db.prepare(`INSERT INTO jobs (order_id, book_id, quantity, color, note, stage, status)
                             VALUES (?, ?, ?, ?, ?, 'cut', 'waiting')`);

  const created = [];
  db.exec('BEGIN');
  try {
    const orderId = Number(insOrder.run(me.id, body.note || null).lastInsertRowid);
    for (const it of items) {
      const book = getBook.get(it.book_id);
      if (!book) throw new HttpError(400, 'ไม่พบหนังสือ');
      const qty = Math.max(1, Number(it.quantity) || book.default_qty);
      const color = COLORS.includes(it.color) ? it.color : book.color;
      const jobId = Number(insJob.run(orderId, book.id, qty, color, it.note || null).lastInsertRowid);
      addEvent(jobId, 'created', 'cut', me.id, null, null);
      created.push({ id: jobId, title: book.title, qty, color });
    }
    db.exec('COMMIT');
    const titles = created.map(c => c.title).join(', ');
    notify(usersForStage('cut'), `งานใหม่ ${created.length} รายการ รอตัดกระดาษ`, titles, '/#queue');
    return { order_id: orderId, jobs: created };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// --- jobs
route('GET', '/api/jobs', (req) => {
  const me = requireUser(req);
  const url = new URL(req.url, 'http://x');
  const where = [];
  const args = [];
  if (url.searchParams.get('mine') === '1' && me.role !== 'admin') {
    const stage = STAGES.find(s => s.role === me.role);
    where.push('j.stage = ?'); args.push(stage.key);
    if (me.role === 'printer') { where.push('j.color = ?'); args.push(machineColor(me.machine)); }
  }
  const stage = url.searchParams.get('stage');
  if (stage) { where.push('j.stage = ?'); args.push(stage); }
  if (url.searchParams.get('active') === '1') where.push("j.status IN ('waiting','working')");
  const limit = Math.min(500, Number(url.searchParams.get('limit')) || 300);
  const sql = JOB_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    " ORDER BY CASE j.status WHEN 'working' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, j.updated_at DESC, j.id DESC LIMIT ?";
  return { jobs: db.prepare(sql).all(...args, limit) };
});

route('GET', '/api/jobs/:id', (req, p) => {
  requireUser(req);
  const job = getJob(p.id);
  const events = db.prepare(`
    SELECT e.*, u.name AS user_name FROM job_events e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.job_id = ? ORDER BY e.id
  `).all(p.id);
  return { job, events };
});

route('POST', '/api/jobs/:id/start', (req, p) => {
  const me = requireUser(req);
  const job = getJob(p.id);
  if (!canWork(me, job)) throw new HttpError(403, 'งานนี้ไม่ได้อยู่ที่แผนกของคุณ');
  if (job.status !== 'waiting') throw new HttpError(409, 'งานนี้เริ่มไปแล้ว');
  const machine = job.stage === 'print' ? (me.machine || job.machine || null) : job.machine;
  db.prepare("UPDATE jobs SET status = 'working', worker_id = ?, machine = ?, updated_at = datetime('now') WHERE id = ?")
    .run(me.id, machine, job.id);
  addEvent(job.id, 'start', job.stage, me.id, machine, null);
  return { job: getJob(job.id) };
});

route('POST', '/api/jobs/:id/finish', async (req, p) => {
  const me = requireUser(req);
  const job = getJob(p.id);
  if (!canWork(me, job)) throw new HttpError(403, 'งานนี้ไม่ได้อยู่ที่แผนกของคุณ');
  if (job.status !== 'working') throw new HttpError(409, 'ต้องกดเริ่มงานก่อน');
  const { note } = await readJson(req).catch(() => ({}));
  const next = nextStage(job.stage);
  addEvent(job.id, 'finish', job.stage, me.id, job.machine, note || null);
  const stageName = stageByKey(job.stage).name;
  if (!next || next.key === 'done') {
    db.prepare("UPDATE jobs SET stage = 'done', status = 'done', worker_id = NULL, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(job.id);
    notify(adminIds(), `เข้าคลังแล้ว: ${job.book_title}`, `${job.quantity.toLocaleString('th-TH')} เล่ม เสร็จครบทุกขั้นตอน`, '/#board');
  } else {
    db.prepare("UPDATE jobs SET stage = ?, status = 'waiting', worker_id = NULL, updated_at = datetime('now') WHERE id = ?").run(next.key, job.id);
    notify(usersForStage(next.key, job.color), `งานใหม่: ${job.book_title}`,
      `${job.quantity.toLocaleString('th-TH')} เล่ม (${job.color}) มาจาก${stageName} รอ${next.name}`, '/#queue');
  }
  return { job: getJob(job.id) };
});

route('POST', '/api/jobs/:id/cancel', (req, p) => {
  const me = requireAdmin(req);
  const job = getJob(p.id);
  if (job.status === 'done' || job.status === 'cancelled') throw new HttpError(409, 'งานนี้ปิดไปแล้ว');
  db.prepare("UPDATE jobs SET status = 'cancelled', worker_id = NULL, updated_at = datetime('now') WHERE id = ?").run(job.id);
  addEvent(job.id, 'cancel', job.stage, me.id, null, null);
  return { job: getJob(job.id) };
});

route('GET', '/api/summary', (req) => {
  requireUser(req);
  const rows = db.prepare("SELECT stage, status, COUNT(*) AS n FROM jobs WHERE status IN ('waiting','working') GROUP BY stage, status").all();
  const doneToday = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'done' AND date(finished_at, 'localtime') = date('now','localtime')").get().n;
  return { rows, doneToday };
});

// --- push subscriptions
route('POST', '/api/push/subscribe', async (req) => {
  const me = requireUser(req);
  const { subscription } = await readJson(req);
  if (!subscription?.endpoint) throw new HttpError(400, 'invalid subscription');
  push.saveSubscription(me.id, subscription);
  return { ok: true };
});

route('POST', '/api/push/unsubscribe', async (req) => {
  requireUser(req);
  const { endpoint } = await readJson(req);
  if (endpoint) push.removeSubscription(endpoint);
  return { ok: true };
});

route('POST', '/api/push/test', (req) => {
  const me = requireUser(req);
  notify([me.id], 'ทดสอบการแจ้งเตือน', 'ถ้าเห็นข้อความนี้ แสดงว่าการแจ้งเตือนใช้งานได้', '/');
  return { ok: true };
});

// ---------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    const ext = path.extname(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // html / js / css / sw are tiny: always revalidate so updates reach phones immediately.
    // Only icons get a long cache.
    headers['Cache-Control'] = ['.html', '.js', '.css', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=86400';
    res.writeHead(200, headers);
    res.end(await readFile(file));
  } catch {
    // SPA fallback
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(await readFile(path.join(PUBLIC_DIR, 'index.html')));
  }
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const data = await r.handler(req, params);
        if (data && typeof data.__html === 'string') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(data.__html);
        }
        return json(res, 200, data);
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error(e);
      return json(res, 500, { error: 'server error' });
    }
  }
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Print Flow running at http://localhost:${PORT}`);
});
