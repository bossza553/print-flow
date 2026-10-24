// Generates a printable sheet of login cards: one card per active user with a
// QR code that opens the app, plus name / station / PIN printed under it.
//
//   node scripts/make-qr-cards.mjs https://your-app-link.example
//
// Output: qr-cards.html (open it and print, or save as PDF from the browser).
import QRCode from 'qrcode';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../lib/db.js';
import { ROLES } from '../lib/workflow.js';

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) {
  console.error('usage: node scripts/make-qr-cards.mjs https://your-app-link');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const users = db.prepare('SELECT name, role, machine, pin FROM users WHERE active = 1 ORDER BY role = \'admin\' DESC, role, id').all();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// QR holds only the app link, never the PIN
const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 220 });

const cards = users.map(u => `
  <div class="card">
    <div class="qr">${qrSvg}</div>
    <div class="name">${esc(u.name)}</div>
    <div class="role">${esc(ROLES[u.role] || u.role)}${u.machine ? ` · เครื่อง ${esc(u.machine)}` : ''}</div>
    <div class="pin-label">รหัส PIN</div>
    <div class="pin">${esc(u.pin)}</div>
    <div class="steps">1. สแกน QR เปิดใน Chrome &nbsp; 2. ใส่ PIN &nbsp; 3. เมนู ⋮ → เพิ่มลงในหน้าจอหลัก &nbsp; 4. ตั้งค่า → เปิดการแจ้งเตือน</div>
    <div class="url">${esc(url)}</div>
  </div>`).join('');

const html = `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<title>Print Flow – บัตรเข้าใช้งาน</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Noto Sans Thai", "Sarabun", "Segoe UI", Roboto, sans-serif; margin: 0; padding: 10mm; background: #eee; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.note { margin: 0 0 12px; color: #555; font-size: 13px; }
  .sheet { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8mm; max-width: 190mm; margin: 0 auto; }
  .card { background: #fff; border: 1.5px dashed #999; border-radius: 10px; padding: 8mm 6mm; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .qr svg { width: 44mm; height: 44mm; }
  .name { font-size: 20px; font-weight: 800; margin-top: 4px; }
  .role { font-size: 14px; color: #1d4ed8; font-weight: 600; }
  .pin-label { font-size: 11px; color: #777; margin-top: 6px; letter-spacing: .1em; }
  .pin { font-size: 34px; font-weight: 900; letter-spacing: .25em; font-variant-numeric: tabular-nums; }
  .steps { font-size: 10px; color: #444; margin-top: 6px; line-height: 1.5; }
  .url { font-size: 9px; color: #999; margin-top: 4px; word-break: break-all; }
  @media print { body { background: #fff; padding: 0; } h1, p.note { display: none; } .sheet { gap: 6mm; } }
</style></head><body>
<h1>Print Flow – บัตรเข้าใช้งาน (${users.length} ใบ)</h1>
<p class="note">พิมพ์หน้านี้ ตัดตามเส้นประ แจกให้พนักงานแต่ละคน · ลิงก์: ${esc(url)}</p>
<div class="sheet">${cards}</div>
</body></html>`;

const out = path.join(ROOT, 'qr-cards.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${users.length} cards) for ${url}`);
