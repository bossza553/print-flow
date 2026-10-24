# Print Flow – ระบบติดตามงานพิมพ์หนังสือ

เว็บแอปสำหรับโรงพิมพ์ ใช้บนมือถือ Android (ติดตั้งเป็นแอปได้ผ่าน Chrome)
พร้อม **แจ้งเตือนแบบ push** เมื่อมีงานมาถึงแผนก แม้ปิดแอปอยู่

## ขั้นตอนการทำงาน (workflow)

```
ผู้ดูแล เลือกหนังสือ → ใส่ตะกร้า → ส่งงาน
  → 1. ตัดกระดาษ
  → 2. พิมพ์   (เครื่อง 2สี / 4สี / 6สี / 8สี-1 / 8สี-2)
  → 3. พับ
  → 4. เก็บ-ไส-ตัด
  → 5. ห่อ / ส่งคลัง
  → เข้าคลังแล้ว
```

- ทุกแผนกเห็นเฉพาะ **งานของตัวเอง** กด "เริ่มทำ" แล้ว "เสร็จแล้ว ส่งต่อ"
- พอกดส่งต่อ งานจะไปอยู่ในคิวแผนกถัดไป และช่างแผนกนั้นได้รับแจ้งเตือนทันที
- งาน 8สี ไปที่คิวร่วมของเครื่อง 8สี-1 และ 8สี-2 ใครว่างก็กดเริ่มได้ ระบบจะบันทึกว่าใช้เครื่องไหน
- ผู้ดูแลเห็นภาพรวมทุกงาน ดูประวัติ และยกเลิกงานได้
- ผู้ดูแลได้รับแจ้งเตือนเมื่อหนังสือเข้าคลังครบทุกขั้นตอน

## ใช้งานจริง (ไม่ต้องมีเซิร์ฟเวอร์ของตัวเอง)

แอปตัวจริงอยู่ที่ **https://bossza553.github.io/print-flow/**

- หน้าเว็บ: GitHub Pages (deploy อัตโนมัติทุกครั้งที่ push โฟลเดอร์ `public/`)
- ฐานข้อมูล + API + ส่งแจ้งเตือน: Supabase Edge Function `api` (โค้ดอยู่ที่ `supabase/functions/api/index.ts`, ตาราง `pf_*`)
- ไฟล์ `public/config.js` เป็นตัวบอกให้หน้าเว็บบน github.io คุยกับ Supabase

แก้โค้ดหน้าเว็บ → push ขึ้น main → รอ 1-2 นาที → ทุกเครื่องได้เวอร์ชันใหม่
แก้โค้ด API → deploy ฟังก์ชัน `api` ใหม่ (ผ่าน Supabase CLI หรือ Claude)

## รันบนเครื่องตัวเอง (สำหรับพัฒนา)

ต้องมี Node.js 22.13 ขึ้นไป (แนะนำ 24+)

```bash
npm install
npm start
```

เปิด http://localhost:3000

### PIN เริ่มต้น (เปลี่ยนได้ในเมนู "พนักงาน")

| ผู้ใช้ | PIN |
|---|---|
| ผู้ดูแลระบบ | 1234 |
| ช่างตัด | 1111 |
| ช่างพิมพ์ 2สี | 2222 |
| ช่างพิมพ์ 4สี | 4444 |
| ช่างพิมพ์ 6สี | 6666 |
| ช่างพิมพ์ 8สี เครื่อง 1 | 8881 |
| ช่างพิมพ์ 8สี เครื่อง 2 | 8882 |
| ช่างพับ | 5555 |
| เก็บ-ไส-ตัด | 7777 |
| ห่อ / ส่งคลัง | 9999 |

ข้อมูลทั้งหมดเก็บในไฟล์ `data/app.db` (SQLite) สำรองข้อมูลโดยก๊อปโฟลเดอร์ `data/`

### บัตร QR เข้าใช้งาน

ผู้ดูแล → **พนักงาน** → **บัตร QR** จะได้หน้าบัตรของพนักงานทุกคน (QR เปิดแอป + ชื่อ + แผนก + PIN)
กด **พิมพ์ / บันทึก PDF** แล้วตัดแจก QR มีแค่ลิงก์แอป ไม่มี PIN อยู่ข้างใน
หรือสร้างเป็นไฟล์จากเครื่อง: `node scripts/make-qr-cards.mjs https://ลิงก์แอป`

## การแจ้งเตือน (สำคัญ)

การแจ้งเตือนแบบ push **ใช้ได้เฉพาะผ่าน HTTPS** (ยกเว้น localhost ตอนทดสอบ)
ดังนั้นเวลาใช้งานจริงต้อง host ให้มี https:// ตามวิธีด้านล่าง

บนมือถือแต่ละเครื่อง:
1. เปิดเว็บใน Chrome → เข้าสู่ระบบด้วย PIN
2. เมนู ⋮ → **ติดตั้งแอป** / **เพิ่มลงในหน้าจอหลัก**
3. เปิดแอปจากไอคอน → ตั้งค่า → **เปิดการแจ้งเตือน** → กด "ส่งทดสอบ"

ระหว่างเปิดแอปอยู่ แอปจะรีเฟรชคิวทุก 8 วินาที และส่งเสียง+สั่นเมื่อมีงานใหม่ด้วย

## วิธี host (เลือก 1 แบบ)

### แบบที่ 1: Cloud (ง่ายที่สุด แนะนำ) – Railway / Render / Fly.io

ได้ HTTPS อัตโนมัติ ไม่ต้องตั้งค่าอะไร ราคาประมาณ $5/เดือน

ตัวอย่าง Railway:
1. อัปโหลดโฟลเดอร์นี้ขึ้น GitHub
2. railway.app → New Project → Deploy from GitHub → เลือก repo
3. Settings → **Volumes** → เพิ่ม volume ที่ mount path `/app/data`
   (สำคัญ: ไม่งั้นฐานข้อมูลหายทุกครั้งที่ deploy ใหม่)
4. Variables → เพิ่ม `VAPID_CONTACT=mailto:อีเมลของคุณ`
5. Settings → Networking → Generate Domain → ได้ลิงก์ https://xxx.up.railway.app
6. ส่งลิงก์ให้พนักงานทุกคน

Fly.io ทำคล้ายกัน: `fly launch` แล้ว `fly volumes create data` และ mount ที่ `/app/data`

### แบบที่ 2: VPS (DigitalOcean, Vultr, Hetzner ~ $5/เดือน)

```bash
# บนเซิร์ฟเวอร์ Ubuntu
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs caddy
git clone <repo ของคุณ> /opt/print-flow && cd /opt/print-flow && npm install
sudo npm i -g pm2 && pm2 start server.js --name print-flow && pm2 save && pm2 startup
```

ชี้โดเมน (เช่น print.บริษัท.com) มาที่ IP เซิร์ฟเวอร์ แล้วตั้งค่า Caddy ที่ `/etc/caddy/Caddyfile`:

```
print.yourcompany.com {
    reverse_proxy localhost:3000
}
```

`sudo systemctl reload caddy` – Caddy จะขอใบรับรอง HTTPS ให้อัตโนมัติ

### แบบที่ 3: คอมในโรงพิมพ์ + Cloudflare Tunnel (ฟรี)

ถ้ามีคอมเปิดทิ้งไว้ในโรงพิมพ์อยู่แล้ว:
1. รัน `npm start` บนคอมเครื่องนั้น
2. ติดตั้ง `cloudflared` แล้ว `cloudflared tunnel --url http://localhost:3000`
   จะได้ลิงก์ https://xxx.trycloudflare.com ใช้ได้ทันที (ลิงก์เปลี่ยนทุกครั้งที่รันใหม่)
3. ถ้าอยากได้ลิงก์ถาวร ให้สมัคร Cloudflare (ฟรี) ใส่โดเมน แล้วสร้าง named tunnel

ข้อเสีย: คอมดับ = ระบบดับ แนะนำแบบที่ 1 หรือ 2 สำหรับใช้งานจริง

## ตัวแปรสภาพแวดล้อม

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `PORT` | 3000 | พอร์ตที่รัน |
| `DATA_DIR` | `./data` | ที่เก็บฐานข้อมูลและกุญแจ push |
| `VAPID_CONTACT` | mailto:admin@example.com | อีเมลติดต่อสำหรับระบบ push |

## API

ทุก endpoint รับ/ส่ง JSON ใส่ header `Authorization: Bearer <token>` หลัง login

| Method | Path | ใคร | ทำอะไร |
|---|---|---|---|
| POST | /api/login `{pin}` | ทุกคน | รับ token |
| GET | /api/me | ทุกคน | ข้อมูลผู้ใช้ปัจจุบัน |
| GET/POST | /api/books, PUT/DELETE /api/books/:id | admin เขียน | จัดการหนังสือ |
| POST | /api/orders `{items:[{book_id,quantity,color,note}]}` | admin | ส่งตะกร้าเข้าสายการผลิต |
| GET | /api/jobs?mine=1&active=1 | ทุกคน | คิวงานของแผนกตัวเอง |
| GET | /api/jobs?stage=print | ทุกคน | งานทั้งหมด (กรองได้) |
| GET | /api/jobs/:id | ทุกคน | รายละเอียด + ประวัติ |
| POST | /api/jobs/:id/start | แผนกนั้น | เริ่มทำ |
| POST | /api/jobs/:id/finish `{note}` | แผนกนั้น | เสร็จ ส่งต่อแผนกถัดไป |
| POST | /api/jobs/:id/cancel | admin | ยกเลิก |
| GET | /api/summary | ทุกคน | จำนวนงานแต่ละแผนก |
| GET/POST/PUT/DELETE | /api/users | admin | จัดการพนักงาน |
| POST | /api/push/subscribe, /api/push/unsubscribe, /api/push/test | ทุกคน | การแจ้งเตือน |

## โครงสร้างไฟล์

```
server.js          – HTTP server + API routes
lib/workflow.js    – ลำดับขั้นตอน, แผนก, เครื่องพิมพ์ (แก้ที่นี่ถ้าเพิ่มแผนก)
lib/db.js          – SQLite schema + ผู้ใช้เริ่มต้น
lib/push.js        – Web Push (VAPID)
public/app.js      – หน้าจอทั้งหมด
public/sw.js       – service worker: รับ push, ทำงาน offline
data/              – ฐานข้อมูล (อย่าลืม backup)
```

## แอป Android (.apk)

โฟลเดอร์ `android/` คือตัวห่อแบบ Trusted Web Activity (Bubblewrap) ที่เปิดเว็บ https://bossza553.github.io/print-flow/ แบบเต็มจอเหมือนแอปจริง
การแจ้งเตือนใช้ระบบเดียวกับเว็บ (Web Push ผ่าน Chrome)

- ดาวน์โหลด: https://bossza553.github.io/print-flow/print-flow.apk (สำเนาเดียวกันอยู่ใน GitHub Releases)
- ไฟล์ `.well-known/assetlinks.json` บน https://bossza553.github.io (repo `bossza553.github.io`) คือสิ่งที่บอก Android ว่าแอปนี้เป็นเจ้าของเว็บ ถ้าไม่มี แอปจะเปิดแบบมีแถบ URL
- **กุญแจเซ็นแอป** `android/android.keystore` + `android/keystore.properties` ไม่ได้อยู่ใน git — สำรองไว้ให้ดี ถ้าหายจะออกอัปเดตแอปเดิมไม่ได้

สร้าง APK ใหม่ (ต้องมี JDK 17 + Android SDK; ดู `~/.bubblewrap/config.json`):

```bash
cd android && npm install
export BUBBLEWRAP_KEYSTORE_PASSWORD=$(sed -n 's/^storePassword=//p' keystore.properties)
export BUBBLEWRAP_KEY_PASSWORD=$BUBBLEWRAP_KEYSTORE_PASSWORD
npx bubblewrap build --skipPwaValidation
```

ได้ไฟล์ `app-release-signed.apk` แล้วอัปโหลดเป็น GitHub Release ชื่อไฟล์ `print-flow.apk`
(เพิ่ม `appVersionCode` ใน `twa-manifest.json` ทุกครั้งที่ออกเวอร์ชันใหม่)
