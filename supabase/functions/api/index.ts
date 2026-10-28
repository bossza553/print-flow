// Print Flow API as a Supabase Edge Function.
// Same routes as server.js, backed by Postgres (tables pf_*) instead of SQLite.
// Deployed with verify_jwt=false: it does its own PIN/session authentication.
import { createClient } from 'npm:@supabase/supabase-js@2';
import * as webpush from 'jsr:@negrel/webpush';
import QRCode from 'npm:qrcode@1.5.4';

// ---------------------------------------------------------------- workflow
const STAGES = [
  { key: 'cut',   name: 'ตัดกระดาษ',    role: 'cutter'  },
  { key: 'print', name: 'พิมพ์',         role: 'printer' },
  { key: 'fold',  name: 'พับ',           role: 'folder'  },
  { key: 'bind',  name: 'เก็บ-ไส-ตัด',   role: 'binder'  },
  { key: 'wrap',  name: 'ห่อ / ส่งคลัง', role: 'wrapper' },
  { key: 'done',  name: 'เข้าคลังแล้ว',  role: null      },
];
const ROLES: Record<string, string> = {
  admin: 'ผู้ดูแลระบบ', cutter: 'ช่างตัดกระดาษ', printer: 'ช่างพิมพ์',
  folder: 'ช่างพับ', binder: 'เก็บ-ไส-ตัด', wrapper: 'ห่อ / ส่งคลัง',
};
const COLORS = ['2สี', '4สี', '6สี', '8สี'];
const MACHINES = [
  { key: '2สี', color: '2สี' }, { key: '4สี', color: '4สี' }, { key: '6สี', color: '6สี' },
  { key: '8สี-1', color: '8สี' }, { key: '8สี-2', color: '8สี' },
];
const stageByKey = (k: string) => STAGES.find(s => s.key === k);
const nextStage = (k: string) => { const i = STAGES.findIndex(s => s.key === k); return i < 0 || i >= STAGES.length - 1 ? null : STAGES[i + 1]; };
const machineColor = (m: string | null) => MACHINES.find(x => x.key === m)?.color || null;
// Printing plates (เพลท) are counted by admin and the press operators; everyone after the
// press works in ยก. PLATES_PER_YOK printing plates make one ยก.
const PLATES_PER_YOK = 2;
const yokOf = (pages: number | null | undefined) => pages == null ? null : Math.round((pages / PLATES_PER_YOK) * 10) / 10;
const yokFmt = (n: number) => Number(n).toLocaleString('th-TH', { maximumFractionDigits: 1 });
const seesPlates = (user: any) => user.role === 'admin' || user.role === 'printer';
// Unit text for a notification going to the people working on `stageKey`.
function unitText(job: any, stageKey: string) {
  if (!job.plates) return '';
  return stageKey === 'print' ? ` · ${Number(job.plates).toLocaleString('th-TH')} เพลท` : ` · ${yokFmt(yokOf(job.plates)!)} ยก`;
}
function canWork(user: any, job: any) {
  if (user.role === 'admin') return true;
  const stage = stageByKey(job.stage);
  if (!stage || stage.role !== user.role) return false;
  if (user.role === 'printer') return machineColor(user.machine) === job.color;
  return true;
}

// ---------------------------------------------------------------- infra
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
};
const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

async function readJson(req: Request) {
  const t = await req.text();
  if (!t) return {};
  try { return JSON.parse(t); } catch { throw new HttpError(400, 'invalid JSON'); }
}
function must<T>(res: { data: T; error: any }): T {
  if (res.error) { console.error(res.error); throw new HttpError(500, 'database error: ' + res.error.message); }
  return res.data;
}
const nowIso = () => new Date().toISOString();
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const thNum = (n: number) => Number(n || 0).toLocaleString('th-TH');

async function auth(req: Request) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const row: any = must(await sb.from('pf_sessions').select('user:pf_users(id,name,role,machine,active)').eq('token', token).maybeSingle());
  const u = row?.user;
  if (!u || !u.active) return null;
  return { id: u.id, name: u.name, role: u.role, machine: u.machine };
}
async function requireUser(req: Request) { const u = await auth(req); if (!u) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ'); return u; }
async function requireAdmin(req: Request) { const u = await requireUser(req); if (u.role !== 'admin') throw new HttpError(403, 'เฉพาะผู้ดูแลระบบเท่านั้น'); return u; }

// ---------------------------------------------------------------- jobs helpers
const JOB_SELECT = '*, book:pf_books(title,code,pages), worker:pf_users(name), paper:pf_paper(name,unit)';
function flat(j: any) {
  // DB column is still named print_pages; the API speaks "plates"
  const { book, worker, paper, print_pages, ...rest } = j;
  return {
    ...rest, book_title: book?.title, book_code: book?.code ?? null, book_pages: book?.pages ?? null, worker_name: worker?.name ?? null,
    paper_name: paper?.name ?? null, paper_unit: paper?.unit ?? null,
    paper_qty: rest.paper_qty == null ? null : Number(rest.paper_qty), paper_used: rest.paper_used == null ? null : Number(rest.paper_used),
    plates: print_pages == null ? null : Number(print_pages), yok: yokOf(print_pages),
  };
}
// Only admin and press operators get the raw plate count; others only see ยก.
const forUser = (user: any) => (j: any) => seesPlates(user) ? j : { ...j, plates: null };
async function getJob(id: string | number) {
  const j = must(await sb.from('pf_jobs').select(JOB_SELECT).eq('id', id).maybeSingle());
  if (!j) throw new HttpError(404, 'ไม่พบงาน');
  return flat(j);
}
async function addEvent(jobId: number, type: string, stage: string, userId: number | null, machine: string | null, note: string | null) {
  must(await sb.from('pf_job_events').insert({ job_id: jobId, type, stage, user_id: userId, machine, note }));
}
async function usersForStage(stageKey: string, color?: string) {
  const stage = stageByKey(stageKey);
  if (!stage?.role) return [];
  const rows: any[] = must(await sb.from('pf_users').select('id,role,machine').eq('active', true).eq('role', stage.role));
  return rows.filter(u => u.role !== 'printer' || machineColor(u.machine) === color).map(u => u.id);
}
async function adminIds() {
  const rows: any[] = must(await sb.from('pf_users').select('id').eq('active', true).eq('role', 'admin'));
  return rows.map(r => r.id);
}

// ---------------------------------------------------------------- push
let appServer: any = null;
let vapidPublicRaw = '';
const b64uToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const bytesToB64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function jwkToRaw(jwk: JsonWebKey) {
  const x = b64uToBytes(jwk.x!), y = b64uToBytes(jwk.y!);
  const out = new Uint8Array(65); out[0] = 4; out.set(x, 1); out.set(y, 33);
  return bytesToB64u(out);
}
async function getPush() {
  if (appServer) return appServer;
  const row: any = must(await sb.from('pf_settings').select('value').eq('key', 'vapid').maybeSingle());
  let exported: { publicKey: JsonWebKey; privateKey: JsonWebKey };
  if (row) {
    exported = JSON.parse(row.value);
  } else {
    const keys = await webpush.generateVapidKeys({ extractable: true });
    exported = await webpush.exportVapidKeys(keys);
    must(await sb.from('pf_settings').upsert({ key: 'vapid', value: JSON.stringify(exported) }));
  }
  vapidPublicRaw = jwkToRaw(exported.publicKey);
  appServer = await webpush.ApplicationServer.new({
    contactInformation: Deno.env.get('VAPID_CONTACT') || 'mailto:admin@example.com',
    vapidKeys: await webpush.importVapidKeys(exported, { extractable: false }),
  });
  return appServer;
}
// Alarm notifications are sent REPEAT times a few seconds apart with the same tag:
// Android replays the sound/vibration on each one (renotify) without stacking notifications.
const ALARM_REPEAT = 4;
const ALARM_GAP_MS = 15000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function notifyUsers(userIds: number[], payload: Record<string, unknown>) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return;
  const subs: any[] = must(await sb.from('pf_push_subs').select('endpoint,sub_json').in('user_id', ids));
  const times = payload.alarm ? ALARM_REPEAT : 1;
  const tag = payload.tag || ('pf-' + Date.now());
  notifyFcm(ids, { ...payload, tag }).catch(e => console.warn('fcm', e?.message ?? e));
  if (!subs.length) return;
  const server = await getPush();
  for (let i = 0; i < times; i++) {
    if (i > 0) await sleep(ALARM_GAP_MS);
    const body = JSON.stringify({ ...payload, tag, ring: i + 1, of: times });
    await Promise.all(subs.map(async s => {
      try {
        await server.subscribe(JSON.parse(s.sub_json)).pushTextMessage(body, { ttl: 43200, urgency: 'high' });
      } catch (e: any) {
        const st = e?.response?.status ?? e?.status;
        if (st === 404 || st === 410 || e?.isGone?.()) await sb.from('pf_push_subs').delete().eq('endpoint', s.endpoint);
        else console.warn('push failed', e?.message ?? e);
      }
    }));
  }
}
// ---------------------------------------------------------------- FCM (native Android app)
// The service-account JSON from Firebase lives in pf_settings['fcm_service_account'] (service role only).
// Data-only, high-priority messages wake the app so it can run its own looping alarm.
let fcmSa: any = null;
let fcmAccess: { token: string; exp: number } | null = null;
const b64u = (bytes: Uint8Array) => bytesToB64u(bytes);
const utf8 = (s: string) => new TextEncoder().encode(s);
async function getFcmSa() {
  if (fcmSa) return fcmSa;
  const row: any = must(await sb.from('pf_settings').select('value').eq('key', 'fcm_service_account').maybeSingle());
  if (!row) return null;
  try { fcmSa = JSON.parse(row.value); } catch { fcmSa = null; }
  return fcmSa;
}
async function fcmAccessToken(sa: any) {
  if (fcmAccess && fcmAccess.exp > Date.now() + 60e3) return fcmAccess.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64u(utf8(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })));
  const pem = String(sa.private_key).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(`${header}.${claims}`)));
  const jwt = `${header}.${claims}.${b64u(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('fcm oauth failed: ' + JSON.stringify(j).slice(0, 200));
  fcmAccess = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmAccess.token;
}
async function notifyFcm(userIds: number[], payload: Record<string, unknown>) {
  const sa = await getFcmSa();
  if (!sa) return;
  const rows: any[] = must(await sb.from('pf_fcm_tokens').select('token').in('user_id', userIds));
  if (!rows.length) return;
  const access = await fcmAccessToken(sa);
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) data[k] = String(v ?? '');
  await Promise.all(rows.map(async r => {
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: r.token, data, android: { priority: 'HIGH', ttl: '43200s' } } }),
      });
      if (res.status === 404 || res.status === 400) {
        const t = await res.text();
        if (/UNREGISTERED|NOT_FOUND|InvalidRegistration|registration-token-not-registered/i.test(t)) await sb.from('pf_fcm_tokens').delete().eq('token', r.token);
        else console.warn('fcm send', res.status, t.slice(0, 200));
      } else if (!res.ok) console.warn('fcm send', res.status, (await res.text()).slice(0, 200));
    } catch (e: any) { console.warn('fcm error', e?.message ?? e); }
  }));
}

function notify(ids: Promise<number[]> | number[], title: string, body: string, url = '', extra: Record<string, unknown> = {}) {
  const p = Promise.resolve(ids).then(list => notifyUsers(list, { title, body, url, alarm: true, ts: Date.now(), ...extra })).catch(e => console.error('notify', e));
  // keep the isolate alive until pushes are sent even though the response already returned
  try { (globalThis as any).EdgeRuntime?.waitUntil(p); } catch { /* local dev */ }
}

// ---------------------------------------------------------------- routes
type Handler = (req: Request, p: Record<string, string>, url: URL) => Promise<unknown> | unknown;
const routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: string, pattern: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

route('GET', '/meta', async () => { await getPush(); return { stages: STAGES, roles: ROLES, colors: COLORS, machines: MACHINES, platesPerYok: PLATES_PER_YOK, pushKey: vapidPublicRaw }; });

route('POST', '/login', async (req) => {
  const { pin } = await readJson(req);
  if (!pin) throw new HttpError(400, 'กรุณาใส่รหัส PIN');
  const user: any = must(await sb.from('pf_users').select('id,name,role,machine').eq('pin', String(pin)).eq('active', true).maybeSingle());
  if (!user) throw new HttpError(401, 'รหัส PIN ไม่ถูกต้อง');
  const token = bytesToB64u(crypto.getRandomValues(new Uint8Array(24)));
  must(await sb.from('pf_sessions').insert({ token, user_id: user.id }));
  return { token, user };
});

route('GET', '/me', async (req) => ({ user: await requireUser(req) }));

route('POST', '/logout', async (req) => {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const { endpoint } = await readJson(req).catch(() => ({} as any));
  if (token) await sb.from('pf_sessions').delete().eq('token', token);
  if (endpoint) await sb.from('pf_push_subs').delete().eq('endpoint', endpoint);
  return { ok: true };
});

// --- users
route('GET', '/users', async (req) => {
  await requireAdmin(req);
  const users = must(await sb.from('pf_users').select('id,name,role,machine,pin,active,created_at').order('role').order('id'));
  return { users };
});
function validateUser(body: any) {
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
const dupPin = (e: any) => { if (e?.code === '23505') throw new HttpError(409, 'PIN นี้ถูกใช้แล้ว'); };
route('POST', '/users', async (req) => {
  await requireAdmin(req);
  const u = validateUser(await readJson(req));
  const res = await sb.from('pf_users').insert(u).select('id').single();
  dupPin(res.error);
  return { id: must(res).id };
});
route('PUT', '/users/:id', async (req, p) => {
  const me = await requireAdmin(req);
  const body = await readJson(req);
  const u = validateUser(body);
  const active = body.active === undefined ? true : !!body.active;
  if (Number(p.id) === me.id && !active) throw new HttpError(400, 'ปิดใช้งานตัวเองไม่ได้');
  const res = await sb.from('pf_users').update({ ...u, active }).eq('id', p.id);
  dupPin(res.error); must(res);
  return { ok: true };
});
route('DELETE', '/users/:id', async (req, p) => {
  const me = await requireAdmin(req);
  if (Number(p.id) === me.id) throw new HttpError(400, 'ลบตัวเองไม่ได้');
  must(await sb.from('pf_users').update({ active: false }).eq('id', p.id));
  await sb.from('pf_sessions').delete().eq('user_id', p.id);
  return { ok: true };
});

// --- qr cards (admin): QR holds only the app link, never the PIN
route('GET', '/qr-cards', async (req, _p, url) => {
  await requireAdmin(req);
  const link = url.searchParams.get('url') || '';
  if (!/^https?:\/\/[^\s"'<>]+$/.test(link)) throw new HttpError(400, 'invalid url');
  const users: any[] = must(await sb.from('pf_users').select('name,role,machine,pin').eq('active', true).order('id'));
  users.sort((a, b) => (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1) || a.role.localeCompare(b.role));
  const qrSvg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 220 });
  const cards = users.map(u => `
  <div class="card"><div class="qr">${qrSvg}</div>
    <div class="name">${esc(u.name)}</div>
    <div class="role">${esc(ROLES[u.role] || u.role)}${u.machine ? ` · เครื่อง ${esc(u.machine)}` : ''}</div>
    <div class="pin-label">รหัส PIN</div><div class="pin">${esc(u.pin)}</div>
    <div class="steps">1. สแกน QR เปิดใน Chrome / Safari &nbsp; 2. ใส่ PIN &nbsp; 3. เพิ่มลงในหน้าจอหลัก &nbsp; 4. ตั้งค่า → เปิดการแจ้งเตือน</div>
    <div class="url">${esc(link)}</div></div>`).join('');
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Print Flow – บัตรเข้าใช้งาน</title><style>
@page{size:A4;margin:10mm}*{box-sizing:border-box}
body{font-family:-apple-system,"Noto Sans Thai","Sarabun","Segoe UI",Roboto,sans-serif;margin:0;padding:12px;background:#eee;color:#111}
h1{font-size:18px;margin:0 0 4px}p.note{margin:0 0 12px;color:#555;font-size:13px;word-break:break-all}
.sheet{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;max-width:190mm;margin:0 auto}
@media(max-width:480px){.sheet{grid-template-columns:1fr}}
.card{background:#fff;border:1.5px dashed #999;border-radius:10px;padding:18px 14px;text-align:center;break-inside:avoid;page-break-inside:avoid}
.qr svg{width:44mm;height:44mm;max-width:70vw;max-height:70vw}
.name{font-size:20px;font-weight:800;margin-top:4px}.role{font-size:14px;color:#1d4ed8;font-weight:600}
.pin-label{font-size:11px;color:#777;margin-top:6px;letter-spacing:.1em}.pin{font-size:34px;font-weight:900;letter-spacing:.25em}
.steps{font-size:10px;color:#444;margin-top:6px;line-height:1.5}.url{font-size:9px;color:#999;margin-top:4px;word-break:break-all}
@media print{body{background:#fff;padding:0}h1,p.note{display:none}.sheet{grid-template-columns:repeat(2,1fr);gap:6mm}}
</style></head><body><h1>Print Flow – บัตรเข้าใช้งาน (${users.length} ใบ)</h1>
<p class="note">พิมพ์หน้านี้ ตัดตามเส้นประ แจกให้พนักงานแต่ละคน · ลิงก์: ${esc(link)}</p><div class="sheet">${cards}</div></body></html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
});

// --- books
route('GET', '/books', async (req) => {
  await requireUser(req);
  const books: any[] = must(await sb.from('pf_books').select('*').eq('active', true).order('title'));
  return { books: books.map(({ print_pages, ...b }) => ({ ...b, plates: print_pages })) };
});
// whole number of printing plates, or null when blank; rejects garbage
function platesOf(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) throw new HttpError(400, 'จำนวนเพลทไม่ถูกต้อง');
  return n > 0 ? Math.round(n) : null;
}
function validateBook(body: any) {
  const title = String(body.title || '').trim();
  if (!title) throw new HttpError(400, 'กรุณาใส่ชื่อหนังสือ');
  const color = String(body.color || '4สี');
  if (!COLORS.includes(color)) throw new HttpError(400, 'จำนวนสีไม่ถูกต้อง');
  return {
    title, code: String(body.code || '').trim() || null,
    pages: body.pages ? Number(body.pages) : null, color,
    print_pages: platesOf(body.plates),
    default_qty: Math.max(1, Number(body.default_qty) || 1000),
    note: String(body.note || '').trim() || null,
  };
}
route('POST', '/books', async (req) => {
  await requireAdmin(req);
  const b = validateBook(await readJson(req));
  return { id: must(await sb.from('pf_books').insert(b).select('id').single()).id };
});
route('PUT', '/books/:id', async (req, p) => {
  await requireAdmin(req);
  must(await sb.from('pf_books').update(validateBook(await readJson(req))).eq('id', p.id));
  return { ok: true };
});
route('DELETE', '/books/:id', async (req, p) => {
  await requireAdmin(req);
  must(await sb.from('pf_books').update({ active: false }).eq('id', p.id));
  return { ok: true };
});

// --- orders: admin submits the basket -> one job per line
route('POST', '/orders', async (req) => {
  const me = await requireAdmin(req);
  const body = await readJson(req);
  const items: any[] = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'ตะกร้าว่าง');
  const books: any[] = must(await sb.from('pf_books').select('*').in('id', items.map(i => Number(i.book_id))).eq('active', true));
  const paperIds = [...new Set(items.map(i => Number(i.paper_id)).filter(n => n > 0))];
  const papers: any[] = paperIds.length ? must(await sb.from('pf_paper').select('id').in('id', paperIds).eq('active', true)) : [];
  const rows = items.map(it => {
    const book = books.find(b => b.id === Number(it.book_id));
    if (!book) throw new HttpError(400, 'ไม่พบหนังสือ');
    const paperId = Number(it.paper_id) > 0 ? Number(it.paper_id) : null;
    if (paperId && !papers.some(p => p.id === paperId)) throw new HttpError(400, 'ไม่พบชนิดกระดาษ');
    const paperQty = paperId && Number(it.paper_qty) > 0 ? Math.round(Number(it.paper_qty) * 100) / 100 : null;
    return {
      book_id: book.id,
      quantity: Math.max(1, Number(it.quantity) || book.default_qty),
      color: COLORS.includes(it.color) ? it.color : book.color,
      note: it.note || null, stage: 'cut', status: 'waiting', title: book.title,
      paper_id: paperId, paper_qty: paperQty,
      // printing plates chosen for this run; falls back to the book's usual count
      print_pages: it.plates === undefined ? (book.print_pages ?? null) : platesOf(it.plates),
    };
  });
  const order: any = must(await sb.from('pf_orders').insert({ created_by: me.id, note: body.note || null }).select('id').single());
  const jobs: any[] = must(await sb.from('pf_jobs').insert(rows.map(({ title: _t, ...r }) => ({ ...r, order_id: order.id }))).select('id,book_id,quantity,color'));
  must(await sb.from('pf_job_events').insert(jobs.map(j => ({ job_id: j.id, type: 'created', stage: 'cut', user_id: me.id }))));
  const created = jobs.map(j => ({ id: j.id, title: books.find(b => b.id === j.book_id)?.title, qty: j.quantity, color: j.color }));
  notify(usersForStage('cut'), `งานใหม่ ${created.length} รายการ รอตัดกระดาษ`, created.map(c => c.title).join(', '), '#queue', { tag: 'order-' + order.id });
  return { order_id: order.id, jobs: created };
});

// --- jobs
route('GET', '/jobs', async (req, _p, url) => {
  const me = await requireUser(req);
  let q = sb.from('pf_jobs').select(JOB_SELECT);
  if (url.searchParams.get('mine') === '1' && me.role !== 'admin') {
    const stage = STAGES.find(s => s.role === me.role)!;
    q = q.eq('stage', stage.key);
    if (me.role === 'printer') q = q.eq('color', machineColor(me.machine) ?? '');
  }
  const stage = url.searchParams.get('stage');
  if (stage) q = q.eq('stage', stage);
  if (url.searchParams.get('active') === '1') q = q.in('status', ['waiting', 'working']);
  const status = url.searchParams.get('status');
  if (status) q = q.eq('status', status);
  const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 300);
  const orderCol = status === 'done' ? 'finished_at' : 'updated_at';
  const rows: any[] = must(await q.order(orderCol, { ascending: false }).order('id', { ascending: false }).limit(limit));
  const rank: Record<string, number> = { working: 0, waiting: 1 };
  rows.sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2));
  return { jobs: rows.map(flat).map(forUser(me)) };
});

route('GET', '/jobs/:id', async (req, p) => {
  const me = await requireUser(req);
  const job = forUser(me)(await getJob(p.id));
  const events: any[] = must(await sb.from('pf_job_events').select('*, user:pf_users(name)').eq('job_id', p.id).order('id'));
  return { job, events: events.map(({ user, ...e }) => ({ ...e, user_name: user?.name ?? null })) };
});

route('POST', '/jobs/:id/start', async (req, p) => {
  const me = await requireUser(req);
  const job = await getJob(p.id);
  if (!canWork(me, job)) throw new HttpError(403, 'งานนี้ไม่ได้อยู่ที่แผนกของคุณ');
  if (job.status !== 'waiting') throw new HttpError(409, 'งานนี้เริ่มไปแล้ว');
  const machine = job.stage === 'print' ? (me.machine || job.machine || null) : job.machine;
  const upd: any[] = must(await sb.from('pf_jobs').update({ status: 'working', worker_id: me.id, machine, updated_at: nowIso() }).eq('id', job.id).eq('status', 'waiting').select('id'));
  if (!upd.length) throw new HttpError(409, 'งานนี้เริ่มไปแล้ว');
  await addEvent(job.id, 'start', job.stage, me.id, machine, null);
  return { job: forUser(me)(await getJob(job.id)) };
});

route('POST', '/jobs/:id/finish', async (req, p) => {
  const me = await requireUser(req);
  const job = await getJob(p.id);
  if (!canWork(me, job)) throw new HttpError(403, 'งานนี้ไม่ได้อยู่ที่แผนกของคุณ');
  if (job.status !== 'working') throw new HttpError(409, 'ต้องกดเริ่มงานก่อน');
  const body = await readJson(req).catch(() => ({} as any));
  const note = body.note;
  const next = nextStage(job.stage);
  const stageName = stageByKey(job.stage)!.name;
  // actual paper consumption: sent by the cutter (prefilled with the plan); recorded once per job
  let paperUsed: number | null = null;
  if (job.paper_id && job.paper_used == null) {
    if (body.paper_used !== undefined && body.paper_used !== null && body.paper_used !== '') {
      const n = Number(body.paper_used);
      if (!isFinite(n) || n < 0) throw new HttpError(400, 'จำนวนกระดาษไม่ถูกต้อง');
      paperUsed = Math.round(n * 100) / 100;
    } else if (job.stage === 'cut' && job.paper_qty) {
      paperUsed = job.paper_qty;
    }
  }
  let upd: any[];
  if (!next || next.key === 'done') {
    upd = must(await sb.from('pf_jobs').update({ stage: 'done', status: 'done', worker_id: null, finished_at: nowIso(), updated_at: nowIso() }).eq('id', job.id).eq('status', 'working').select('id'));
  } else {
    upd = must(await sb.from('pf_jobs').update({ stage: next.key, status: 'waiting', worker_id: null, updated_at: nowIso() }).eq('id', job.id).eq('status', 'working').select('id'));
  }
  if (!upd.length) throw new HttpError(409, 'งานนี้ถูกส่งต่อไปแล้ว');
  await addEvent(job.id, 'finish', job.stage, me.id, job.machine, note || null);
  if (paperUsed != null) {
    await sb.from('pf_jobs').update({ paper_used: paperUsed }).eq('id', job.id);
    if (paperUsed > 0) {
      const r = await paperMove(job.paper_id, paperUsed, 'use', me.id, job.id, `ใช้กับงาน #${job.id} ${job.book_title}`);
      await lowStockCheck(job.paper_id, r.qty_after);
    }
  }
  if (!next || next.key === 'done') {
    notify(adminIds(), `เข้าคลังแล้ว: ${job.book_title}`, `${thNum(job.quantity)} เล่ม${unitText(job, 'done')} เสร็จครบทุกขั้นตอน`, '#board');
  } else {
    notify(usersForStage(next.key, job.color), `งานใหม่: ${job.book_title}`, `${thNum(job.quantity)} เล่ม (${job.color})${unitText(job, next.key)} มาจาก${stageName} รอ${next.name}`, '#queue', { tag: 'job-' + job.id });
  }
  return { job: forUser(me)(await getJob(job.id)) };
});

route('POST', '/jobs/:id/cancel', async (req, p) => {
  const me = await requireAdmin(req);
  const job = await getJob(p.id);
  if (job.status === 'done' || job.status === 'cancelled') throw new HttpError(409, 'งานนี้ปิดไปแล้ว');
  must(await sb.from('pf_jobs').update({ status: 'cancelled', worker_id: null, updated_at: nowIso() }).eq('id', job.id));
  await addEvent(job.id, 'cancel', job.stage, me.id, null, null);
  return { job: await getJob(job.id) };
});

route('GET', '/summary', async (req) => {
  await requireUser(req);
  const active: any[] = must(await sb.from('pf_jobs').select('stage,status').in('status', ['waiting', 'working']));
  const counts = new Map<string, number>();
  for (const r of active) counts.set(r.stage + '|' + r.status, (counts.get(r.stage + '|' + r.status) || 0) + 1);
  const rows = [...counts].map(([k, n]) => { const [stage, status] = k.split('|'); return { stage, status, n }; });
  // "today" in Thailand (UTC+7)
  const bkk = new Date(Date.now() + 7 * 3600e3); bkk.setUTCHours(0, 0, 0, 0);
  const dayStart = new Date(bkk.getTime() - 7 * 3600e3).toISOString();
  const { count } = await sb.from('pf_jobs').select('id', { count: 'exact', head: true }).eq('status', 'done').gte('finished_at', dayStart);
  return { rows, doneToday: count ?? 0 };
});

// --- push
route('POST', '/push/subscribe', async (req) => {
  const me = await requireUser(req);
  const { subscription } = await readJson(req);
  if (!subscription?.endpoint) throw new HttpError(400, 'invalid subscription');
  must(await sb.from('pf_push_subs').upsert({ user_id: me.id, endpoint: subscription.endpoint, sub_json: JSON.stringify(subscription) }, { onConflict: 'endpoint' }));
  return { ok: true };
});
route('POST', '/push/unsubscribe', async (req) => {
  await requireUser(req);
  const { endpoint } = await readJson(req);
  if (endpoint) await sb.from('pf_push_subs').delete().eq('endpoint', endpoint);
  return { ok: true };
});
route('POST', '/push/test', async (req) => {
  const me = await requireUser(req);
  // send synchronously so the client learns about failures
  await notifyUsers([me.id], { title: 'ทดสอบการแจ้งเตือน', body: 'จะดัง 3 ครั้งติดกัน ถ้าเบาไป ให้ตั้งเสียงแจ้งเตือนของแอปเป็นเสียงปลุก', url: '', alarm: true, tag: 'pf-test', ts: Date.now() });
  return { ok: true };
});

// --- paper stock -------------------------------------------------------
const PAPER_SELECT = 'id,name,unit,qty,min_qty,note,active,updated_at';
async function paperMove(paperId: number, amount: number, type: 'in' | 'use' | 'adjust', userId: number, jobId: number | null, note: string | null) {
  const res = await sb.rpc('pf_paper_move', { p_paper_id: paperId, p_amount: amount, p_type: type, p_user_id: userId, p_job_id: jobId, p_note: note });
  if (res.error) { if (/paper not found/.test(res.error.message)) throw new HttpError(404, 'ไม่พบกระดาษ'); throw new HttpError(500, res.error.message); }
  const row = Array.isArray(res.data) ? res.data[0] : res.data;
  return { qty_after: Number(row.qty_after), delta: Number(row.delta) };
}
async function lowStockCheck(paperId: number, qtyAfter: number) {
  const paper: any = must(await sb.from('pf_paper').select(PAPER_SELECT).eq('id', paperId).maybeSingle());
  if (!paper || Number(paper.min_qty) <= 0 || qtyAfter > Number(paper.min_qty)) return;
  notify(adminIds(), `📄 กระดาษใกล้หมด: ${paper.name}`, `เหลือ ${thNum(qtyAfter)} ${paper.unit} (ขั้นต่ำ ${thNum(Number(paper.min_qty))})`, '#paper', { alarm: false, tag: 'paper-' + paper.id });
}
function validatePaper(body: any) {
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(400, 'กรุณาใส่ชื่อกระดาษ');
  return { name, unit: String(body.unit || 'รีม').trim() || 'รีม', min_qty: Math.max(0, Number(body.min_qty) || 0), note: String(body.note || '').trim() || null };
}
const amountOf = (v: unknown) => { const n = Number(v); if (!isFinite(n) || n <= 0) throw new HttpError(400, 'จำนวนต้องมากกว่า 0'); return Math.round(n * 100) / 100; };

route('GET', '/paper', async (req) => {
  await requireUser(req);
  const papers: any[] = must(await sb.from('pf_paper').select(PAPER_SELECT).eq('active', true).order('name'));
  return { papers: papers.map(p => ({ ...p, qty: Number(p.qty), min_qty: Number(p.min_qty) })) };
});
route('POST', '/paper', async (req) => {
  const me = await requireAdmin(req);
  const body = await readJson(req);
  const p = validatePaper(body);
  const created: any = must(await sb.from('pf_paper').insert(p).select('id').single());
  const initial = Number(body.qty) || 0;
  if (initial > 0) await paperMove(created.id, initial, 'in', me.id, null, 'ยอดเริ่มต้น');
  return { id: created.id };
});
route('PUT', '/paper/:id', async (req, p) => {
  await requireAdmin(req);
  const body = await readJson(req);
  const upd: any = validatePaper(body);
  if (body.active !== undefined) upd.active = !!body.active;
  upd.updated_at = nowIso();
  must(await sb.from('pf_paper').update(upd).eq('id', p.id));
  return { ok: true };
});
route('POST', '/paper/:id/add', async (req, p) => {
  const me = await requireAdmin(req);
  const { amount, note } = await readJson(req);
  const r = await paperMove(Number(p.id), amountOf(amount), 'in', me.id, null, note || null);
  return r;
});
route('POST', '/paper/:id/adjust', async (req, p) => {
  const me = await requireAdmin(req);
  const { qty, note } = await readJson(req);
  const n = Number(qty); if (!isFinite(n) || n < 0) throw new HttpError(400, 'จำนวนไม่ถูกต้อง');
  const r = await paperMove(Number(p.id), Math.round(n * 100) / 100, 'adjust', me.id, null, note || 'นับสต็อก');
  await lowStockCheck(Number(p.id), r.qty_after);
  return r;
});
route('POST', '/paper/:id/use', async (req, p) => {
  const me = await requireUser(req);
  const { amount, job_id, note } = await readJson(req);
  const jobId = job_id ? Number(job_id) : null;
  const r = await paperMove(Number(p.id), amountOf(amount), 'use', me.id, jobId, note || null);
  await lowStockCheck(Number(p.id), r.qty_after);
  return r;
});
route('GET', '/paper/:id/moves', async (req, p) => {
  await requireUser(req);
  const rows: any[] = must(await sb.from('pf_paper_moves').select('*, user:pf_users(name), job:pf_jobs(id, book:pf_books(title))').eq('paper_id', p.id).order('id', { ascending: false }).limit(100));
  return { moves: rows.map(({ user, job, ...m }) => ({ ...m, delta: Number(m.delta), qty_after: Number(m.qty_after), user_name: user?.name ?? null, job_title: job?.book?.title ?? null })) };
});

// --- native app device tokens
route('POST', '/fcm/register', async (req) => {
  const me = await requireUser(req);
  const { token, platform } = await readJson(req);
  if (!token || String(token).length < 20) throw new HttpError(400, 'invalid token');
  must(await sb.from('pf_fcm_tokens').upsert({ user_id: me.id, token: String(token), platform: String(platform || 'android'), updated_at: nowIso() }, { onConflict: 'token' }));
  return { ok: true, fcmConfigured: !!(await getFcmSa()) };
});
route('POST', '/fcm/unregister', async (req) => {
  const { token } = await readJson(req);
  if (token) await sb.from('pf_fcm_tokens').delete().eq('token', String(token));
  return { ok: true };
});

// --- reminders: called by pg_cron every 2 minutes.
// Any job still "waiting" 3+ minutes after it arrived gets re-announced to its station,
// at most every 2 minutes and at most 6 times (≈ 15 minutes of nagging).
route('POST', '/remind', async (req) => {
  const key = req.headers.get('x-cron-key') || '';
  const row: any = must(await sb.from('pf_settings').select('value').eq('key', 'cron_key').maybeSingle());
  if (!row || key !== row.value) throw new HttpError(401, 'bad cron key');
  const cutoff = new Date(Date.now() - 3 * 60e3).toISOString();
  const again = new Date(Date.now() - 2 * 60e3).toISOString();
  const jobs: any[] = must(await sb.from('pf_jobs').select(JOB_SELECT)
    .eq('status', 'waiting').lt('updated_at', cutoff).lt('remind_count', 6)
    .or(`reminded_at.is.null,reminded_at.lt.${again}`));
  let sent = 0;
  for (const raw of jobs) {
    const j = flat(raw);
    const minutes = Math.round((Date.now() - new Date(j.updated_at).getTime()) / 60e3);
    const stage = stageByKey(j.stage)!;
    await notifyUsers(await usersForStage(j.stage, j.color), {
      title: `⏰ งานรอคิวอยู่ ${minutes} นาทีแล้ว!`,
      body: `${j.book_title} · ${thNum(j.quantity)} เล่ม (${j.color})${unitText(j, j.stage)} รอ${stage.name} — กดเริ่มทำด้วย`,
      url: '#queue', alarm: true, tag: 'job-' + j.id, ts: Date.now(),
    });
    await sb.from('pf_jobs').update({ reminded_at: nowIso(), remind_count: (j.remind_count || 0) + 1 }).eq('id', j.id);
    sent++;
  }
  return { ok: true, reminded: sent };
});

// ---------------------------------------------------------------- server
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  // accept /functions/v1/api/x, /api/x and /x
  const path = url.pathname.replace(/^\/functions\/v1/, '').replace(/^\/api(?=\/|$)/, '') || '/';
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.handler(req, params, url);
      return out instanceof Response ? out : json(200, out);
    }
    return json(404, { error: 'not found: ' + path });
  } catch (e: any) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'server error' });
  }
});
