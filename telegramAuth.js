// Telegram Mini App initData tekshiruvi (HMAC-SHA256, bot tokeni bilan)
// Hujjat: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// Mini-app har bir API so'rovida Telegram.WebApp.initData ni "X-Telegram-Init-Data"
// sarlavhasida yuboradi. Server faqat imzosi to'g'ri initData'dagi user.id ga ishonadi.
const crypto = require('crypto');

// initData amal qilish muddati (soniya) — mini-app ochilgan paytdan boshlab hisoblanadi
const MAX_AGE_SEC = parseInt(process.env.INITDATA_MAX_AGE_SEC || '86400');

// secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
function secretKey(botToken) {
  return crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
}

// "hash" dan boshqa barcha maydonlar (signature ham), kalit bo'yicha alifbo tartibida, "\n" bilan
function dataCheckString(params) {
  return Array.from(params.entries())
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('\n');
}

// Muvaffaqiyat: {user}. Xato: {error} — 'missing' | 'no_hash' | 'bad_hash' | 'expired' | 'no_user'
function verifyInitData(initData, botToken, maxAgeSec = MAX_AGE_SEC) {
  if (!initData || !botToken) return { error: 'missing' };
  const params = new URLSearchParams(String(initData));
  const hash = params.get('hash') || '';
  if (!/^[0-9a-f]{64}$/i.test(hash)) return { error: 'no_hash' };
  const expected = crypto.createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return { error: 'bad_hash' };
  const authDate = parseInt(params.get('auth_date') || '0');
  if (!authDate || (maxAgeSec > 0 && Date.now() / 1000 - authDate > maxAgeSec)) return { error: 'expired' };
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) {}
  if (!user || !user.id) return { error: 'no_user' };
  return { user };
}

// Lokal E2E/testlar uchun: bot tokeni bilan imzolangan initData yasaydi
function signInitData(user, botToken, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
  params.set('hash', crypto.createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest('hex'));
  return params.toString();
}

module.exports = { MAX_AGE_SEC, verifyInitData, signInitData };
