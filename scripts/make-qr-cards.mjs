// Writes qr-cards.html: a printable sheet of login cards (QR + name + PIN).
// The same sheet is available inside the app: admin → พนักงาน → บัตร QR.
//
//   node scripts/make-qr-cards.mjs https://your-app-link.example
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderQrCards } from '../lib/qrcards.js';

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) {
  console.error('usage: node scripts/make-qr-cards.mjs https://your-app-link');
  process.exit(1);
}

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'qr-cards.html');
writeFileSync(out, await renderQrCards(url));
console.log(`wrote ${out} for ${url}`);
