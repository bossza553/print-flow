// Renders the printable login-card sheet: one card per active user with a QR
// code that opens the app, plus name / station / PIN. The QR holds only the
// app link, never the PIN.
import QRCode from 'qrcode';
import { db } from './db.js';
import { ROLES } from './workflow.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function renderQrCards(url) {
  const users = db.prepare("SELECT name, role, machine, pin FROM users WHERE active = 1 ORDER BY role = 'admin' DESC, role, id").all();
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 220 });

  const cards = users.map(u => `
  <div class="card">
    <div class="qr">${qrSvg}</div>
    <div class="name">${esc(u.name)}</div>
    <div class="role">${esc(ROLES[u.role] || u.role)}${u.machine ? ` · เครื่อง ${esc(u.machine)}` : ''}</div>
    <div class="pin-label">รหัส PIN</div>
    <div class="pin">${esc(u.pin)}</div>
    <div class="steps">1. สแกน QR เปิดใน Chrome / Safari &nbsp; 2. ใส่ PIN &nbsp; 3. เพิ่มลงในหน้าจอหลัก &nbsp; 4. ตั้งค่า → เปิดการแจ้งเตือน</div>
    <div class="url">${esc(url)}</div>
  </div>`).join('');

  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Print Flow – บัตรเข้าใช้งาน</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Noto Sans Thai", "Sarabun", "Segoe UI", Roboto, sans-serif; margin: 0; padding: 12px; background: #eee; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.note { margin: 0 0 12px; color: #555; font-size: 13px; word-break: break-all; }
  .sheet { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; max-width: 190mm; margin: 0 auto; }
  @media (max-width: 480px) { .sheet { grid-template-columns: 1fr; } }
  .card { background: #fff; border: 1.5px dashed #999; border-radius: 10px; padding: 18px 14px; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .qr svg { width: 44mm; height: 44mm; max-width: 70vw; max-height: 70vw; }
  .name { font-size: 20px; font-weight: 800; margin-top: 4px; }
  .role { font-size: 14px; color: #1d4ed8; font-weight: 600; }
  .pin-label { font-size: 11px; color: #777; margin-top: 6px; letter-spacing: .1em; }
  .pin { font-size: 34px; font-weight: 900; letter-spacing: .25em; font-variant-numeric: tabular-nums; }
  .steps { font-size: 10px; color: #444; margin-top: 6px; line-height: 1.5; }
  .url { font-size: 9px; color: #999; margin-top: 4px; word-break: break-all; }
  @media print { body { background: #fff; padding: 0; } h1, p.note { display: none; } .sheet { grid-template-columns: repeat(2, 1fr); gap: 6mm; } }
</style></head><body>
<h1>Print Flow – บัตรเข้าใช้งาน (${users.length} ใบ)</h1>
<p class="note">พิมพ์หน้านี้ ตัดตามเส้นประ แจกให้พนักงานแต่ละคน · ลิงก์: ${esc(url)}</p>
<div class="sheet">${cards}</div>
</body></html>`;
}
