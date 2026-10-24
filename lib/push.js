// Web Push notifications (works on Android Chrome even when the app is closed).
// VAPID keys are generated once and stored in data/vapid.json.
import webpush from 'web-push';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

const keyFile = path.join(DATA_DIR, 'vapid.json');
let keys;
if (existsSync(keyFile)) {
  keys = JSON.parse(readFileSync(keyFile, 'utf8'));
} else {
  keys = webpush.generateVAPIDKeys();
  writeFileSync(keyFile, JSON.stringify(keys, null, 2));
  console.log('[push] generated new VAPID keys ->', keyFile);
}

const contact = process.env.VAPID_CONTACT || 'mailto:admin@example.com';
webpush.setVapidDetails(contact, keys.publicKey, keys.privateKey);

export const publicKey = keys.publicKey;

export function saveSubscription(userId, sub) {
  db.prepare(`
    INSERT INTO push_subs (user_id, endpoint, sub_json) VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, sub_json = excluded.sub_json
  `).run(userId, sub.endpoint, JSON.stringify(sub));
}

export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
}

/** Send a notification to every device of the given user ids. Fire-and-forget. */
export async function notifyUsers(userIds, payload) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT endpoint, sub_json FROM push_subs WHERE user_id IN (${placeholders})`).all(...ids);
  const body = JSON.stringify(payload);
  await Promise.all(rows.map(async row => {
    try {
      await webpush.sendNotification(JSON.parse(row.sub_json), body, { TTL: 60 * 60 * 12 });
    } catch (err) {
      // 404 / 410 mean the subscription is dead (app uninstalled, permission revoked)
      if (err.statusCode === 404 || err.statusCode === 410) {
        removeSubscription(row.endpoint);
      } else {
        console.warn('[push] send failed', err.statusCode || err.message);
      }
    }
  }));
}
