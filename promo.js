// Birinchi buyurtma aksiyasi (1+1): asosiy mahsulot aksiya narxida + bitta sovg'a (tanlov bilan).
// Qoidalar: faqat botda ro'yxatdan o'tgan mijoz, faqat birinchi buyurtmasida, bitta sovg'a,
// har bir Telegram akkaunt va har bir telefon raqam uchun bir marta (promo_redemptions UNIQUE).
const db = require('./db');

const PROMO_KEY = 'first_order_1plus1';
const SETTINGS_KEY = 'promo:' + PROMO_KEY;
const MAX_GIFTS = 3;
const DEFAULTS = { enabled: false, title: '1+1 AKSIYA', base_product_id: null, price: 30000, gift_product_ids: [] };

function getConfig() {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTINGS_KEY);
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch (e) {}
  return Object.assign({}, DEFAULTS, saved);
}

// Admin paneldan: tekshirib saqlaydi, xato bo'lsa {error}
function saveConfig(input) {
  const cfg = {
    enabled: !!(input && input.enabled),
    title: String((input && input.title) || DEFAULTS.title).trim().slice(0, 60) || DEFAULTS.title,
    base_product_id: parseInt(input && input.base_product_id) || null,
    price: Number(input && input.price),
    gift_product_ids: []
  };
  if (!Number.isInteger(cfg.price) || cfg.price < 0 || cfg.price > 10000000) return { error: "Aksiya narxi noto'g'ri" };
  const gifts = Array.isArray(input && input.gift_product_ids) ? input.gift_product_ids : [];
  for (const g of gifts) {
    const id = parseInt(g);
    if (id > 0 && !cfg.gift_product_ids.includes(id)) cfg.gift_product_ids.push(id);
  }
  if (cfg.gift_product_ids.length > MAX_GIFTS) return { error: "Sovg'a variantlari " + MAX_GIFTS + ' tadan oshmasin' };
  const exists = id => !!db.prepare('SELECT 1 FROM products WHERE id=?').get(id);
  if (cfg.base_product_id && !exists(cfg.base_product_id)) return { error: 'Asosiy mahsulot topilmadi' };
  if (cfg.gift_product_ids.some(id => !exists(id))) return { error: "Sovg'a mahsuloti topilmadi" };
  if (cfg.enabled && (!cfg.base_product_id || !cfg.gift_product_ids.length)) {
    return { error: "Aksiyani yoqish uchun asosiy mahsulot va kamida bitta sovg'a tanlang" };
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(SETTINGS_KEY, JSON.stringify(cfg));
  return { ok: true, config: cfg };
}

// Menyuda hozir mavjud (faol mahsulot + faol kategoriya) bo'lgan mahsulot
function liveProduct(id) {
  if (!id) return null;
  return db.prepare('SELECT p.id, p.name_uz, p.price, p.image FROM products p LEFT JOIN categories c ON c.id=p.category_id' +
    ' WHERE p.id=? AND p.active=1 AND c.active=1').get(id) || null;
}

// Mijozga ko'rsatiladigan taklif; o'chirilgan yoki mahsulotlar menyuda bo'lmasa — null
function getOffer() {
  const cfg = getConfig();
  if (!cfg.enabled) return null;
  const base = liveProduct(cfg.base_product_id);
  const gifts = cfg.gift_product_ids.map(liveProduct).filter(Boolean);
  if (!base || !gifts.length) return null;
  return {
    key: PROMO_KEY, title: cfg.title, price: cfg.price,
    base: { id: base.id, name: base.name_uz, image: base.image || '', regular_price: base.price },
    gifts: gifts.map(g => ({ id: g.id, name: g.name_uz, image: g.image || '', regular_price: g.price }))
  };
}

const phoneDigits = p => String(p || '').replace(/\D/g, '');

// Mijoz uchun holat: {enabled, eligible, reason, message, offer}
function statusFor(userId) {
  const offer = getOffer();
  if (!offer) return { enabled: false, eligible: false };
  const out = { enabled: true, eligible: false, offer };
  const customer = userId ? db.prepare('SELECT * FROM customers WHERE telegram_id=?').get(String(userId)) : null;
  if (!customer) {
    return Object.assign(out, { reason: 'not_registered',
      message: "Aksiya botda ro'yxatdan o'tgan mijozlar uchun. Botga qaytib, «📞 Telefon raqamni yuborish» tugmasi orqali ro'yxatdan o'ting." });
  }
  const used = db.prepare('SELECT order_id FROM promo_redemptions WHERE promo=? AND (user_id=? OR phone=?)')
    .get(PROMO_KEY, String(userId), phoneDigits(customer.phone));
  if (used) {
    return Object.assign(out, { reason: 'used', order_id: used.order_id,
      message: 'Siz bu aksiyadan foydalangansiz (buyurtma #' + used.order_id + '). Aksiya har bir mijoz uchun faqat bir marta amal qiladi.' });
  }
  const prev = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE user_id=? AND status!='cancelled'").get(String(userId)).c;
  if (prev > 0) {
    return Object.assign(out, { reason: 'not_first', message: 'Aksiya faqat birinchi buyurtma uchun amal qiladi.' });
  }
  out.eligible = true;
  out.customer_phone = phoneDigits(customer.phone);
  return out;
}

// Buyurtma uchun: tekshiradi va savatcha qatorlarini qaytaradi ({lines, redemption} yoki {error})
function buildOrderLines(userId, giftId) {
  const st = statusFor(userId);
  if (!st.enabled) return { error: 'Aksiya hozir faol emas.' };
  if (!st.eligible) return { error: st.message };
  const gift = st.offer.gifts.find(g => g.id === Number(giftId));
  if (!gift) return { error: "Tanlangan sovg'a hozir mavjud emas. Boshqasini tanlang." };
  const o = st.offer;
  return {
    offer: o,
    lines: [
      { id: o.base.id, name_uz: o.base.name + ' (' + o.title + ')', qty: 1, price: o.price, promo: true },
      { id: gift.id, name_uz: gift.name + " (sovg'a)", qty: 1, price: 0, promo: true, gift: true }
    ],
    redemption: { promo: PROMO_KEY, user_id: String(userId), phone: st.customer_phone, gift_product_id: gift.id }
  };
}

function recordRedemption(r, orderId) {
  db.prepare('INSERT INTO promo_redemptions (promo, user_id, phone, order_id, gift_product_id) VALUES (?,?,?,?,?)')
    .run(r.promo, r.user_id, r.phone, orderId, r.gift_product_id);
}

// Buyurtma bekor qilinsa — mijoz sovg'ani olmadi, aksiya qaytariladi
function releaseForOrder(orderId) {
  return db.prepare('DELETE FROM promo_redemptions WHERE order_id=?').run(orderId).changes;
}

function stats(limit = 50) {
  const total = db.prepare('SELECT COUNT(*) AS c FROM promo_redemptions WHERE promo=?').get(PROMO_KEY).c;
  const last = db.prepare(
    'SELECT r.order_id, r.user_id, r.created_at, o.user_name, o.status, o.total, p.name_uz AS gift_name FROM promo_redemptions r' +
    ' LEFT JOIN orders o ON o.id=r.order_id LEFT JOIN products p ON p.id=r.gift_product_id' +
    ' WHERE r.promo=? ORDER BY r.id DESC LIMIT ?'
  ).all(PROMO_KEY, limit);
  return { total, last };
}

module.exports = { PROMO_KEY, MAX_GIFTS, getConfig, saveConfig, getOffer, statusFor, buildOrderLines, recordRedemption, releaseForOrder, stats };
