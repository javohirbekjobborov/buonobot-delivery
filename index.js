require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');
const iiko = require('./iiko');

// Bonus tizimi konfiguratsiyasi
const BONUS_PERCENT = parseFloat(process.env.BONUS_PERCENT || '3');
const WELCOME_BONUS = parseInt(process.env.WELCOME_BONUS || '5000');
const BONUS_TTL_DAYS = parseInt(process.env.BONUS_TTL_DAYS || '15');
const MAX_BONUS_USE_PERCENT = parseInt(process.env.MAX_BONUS_USE_PERCENT || '50');

// Restoran joylashuvi + yetkazib berish radiusi
const RESTAURANT_LAT = parseFloat(process.env.RESTAURANT_LAT || '41.3588914');
const RESTAURANT_LNG = parseFloat(process.env.RESTAURANT_LNG || '69.3366373');
const RESTAURANT_ADDRESS = process.env.RESTAURANT_ADDRESS || "Yunusobod tumani, Gullola ko'chasi 13";
const DELIVERY_RADIUS_KM = parseFloat(process.env.DELIVERY_RADIUS_KM || '3');
const ETA_MIN_MINUTES = parseInt(process.env.ETA_MIN_MINUTES || '30');
const ETA_MAX_MINUTES = parseInt(process.env.ETA_MAX_MINUTES || '60');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Joriy vaqtga 30-60 daqiqa qo'shib, mahalliy (UTC+5) vaqt oralig'i sifatida formatlaymiz
function estimatedDeliveryWindow() {
  const now = Date.now();
  const min = new Date(now + ETA_MIN_MINUTES*60*1000 + 5*3600*1000);
  const max = new Date(now + ETA_MAX_MINUTES*60*1000 + 5*3600*1000);
  const fmt = d => String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');
  return fmt(min) + '–' + fmt(max);
}
function estimatedDeliveryText() {
  return ETA_MIN_MINUTES + '–' + ETA_MAX_MINUTES + ' daqiqa (taxminan ' + estimatedDeliveryWindow() + ')';
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'http://localhost:' + PORT;
const ADMIN_IDS = (process.env.ADMIN_CHAT_ID || '').split(',').map(s=>s.trim()).filter(Boolean);
const COURIER_IDS = (process.env.COURIER_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
const ORDERS_GROUP_ID = process.env.ORDERS_GROUP_ID || '';
const FEEDBACK_GROUP_ID = process.env.FEEDBACK_GROUP_ID || '';

// Buyurtmalar va buyurtma bilan bog'liq baholar shu yerga ketadi.
// Bo'sh bo'lsa — ADMIN_IDS ga.
function orderRecipients() {
  return ORDERS_GROUP_ID ? [ORDERS_GROUP_ID] : ADMIN_IDS;
}
// Buyurtma_id ga bog'lanmagan baho/taklif/shikoyat shu yerga ketadi.
// Bo'sh bo'lsa — ADMIN_IDS ga.
function generalFeedbackRecipients() {
  return FEEDBACK_GROUP_ID ? [FEEDBACK_GROUP_ID] : ADMIN_IDS;
}

app.use(express.json({limit:'5mb'}));
app.use(express.static(path.join(__dirname, 'public')));

function getTid(req) {
  return req.headers['x-telegram-id'] || req.query.uid || '';
}
function isAdmin(req) {
  const tid = String(getTid(req) || '');
  if (!tid) return false;
  // ENV-da ko'rsatilgan ADMIN_IDS har doim admin (DB resetdan keyin ham ishlaydi)
  if (ADMIN_IDS.includes(tid)) return true;
  const u = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid);
  return u && u.role === 'admin';
}

// ── CUSTOMER & BONUS HELPERS ─────────────────────────────────────────────────

function generateCardNumber() {
  // 10 raqamli noyob karta raqami (1000000000..9999999999)
  for (let i = 0; i < 20; i++) {
    const n = String(Math.floor(1e9 + Math.random() * 9e9));
    const existing = db.prepare('SELECT 1 FROM customers WHERE card_number=?').get(n);
    if (!existing) return n;
  }
  // Fallback: ts-based
  return String(1000000000 + (Date.now() % 9000000000));
}

function getCustomer(telegramId) {
  return db.prepare('SELECT * FROM customers WHERE telegram_id=?').get(String(telegramId));
}

function getCustomerByCard(cardNumber) {
  return db.prepare('SELECT * FROM customers WHERE card_number=?').get(String(cardNumber));
}

function registerCustomer(telegramId, firstName, lastName, username, phone) {
  const existing = getCustomer(telegramId);
  if (existing) {
    // Telefon yangilash
    if (phone && phone !== existing.phone) {
      db.prepare('UPDATE customers SET phone=? WHERE telegram_id=?').run(phone, String(telegramId));
    }
    return { customer: getCustomer(telegramId), isNew: false };
  }
  const cardNumber = generateCardNumber();
  db.prepare('INSERT INTO customers (telegram_id, card_number, phone, first_name, last_name, username) VALUES (?,?,?,?,?,?)')
    .run(String(telegramId), cardNumber, phone||'', firstName||'', lastName||'', username||'');

  // Welcome bonus
  if (WELCOME_BONUS > 0) {
    creditBonus(telegramId, WELCOME_BONUS, 'welcome', null);
  }

  // iiko CRM ga sinxronlash (agar yoqilgan bo'lsa)
  const customer = getCustomer(telegramId);
  if (iiko.isConfigured() && iiko.crmEnabled()) {
    setImmediate(async () => {
      try {
        const r = await iiko.customerCreateOrUpdate(customer);
        if (r && r.id) {
          db.prepare('UPDATE customers SET iiko_customer_id=? WHERE telegram_id=?').run(r.id, customer.telegram_id);
          // Karta raqamini alohida endpoint orqali qo'shamiz
          if (customer.card_number) {
            try { await iiko.customerCardAdd(r.id, customer.card_number); }
            catch(e) { console.warn('[iiko] card add failed:', e.message); }
          }
          console.log('[iiko] customer synced:', customer.telegram_id, '→', r.id);
        }
      } catch(e) { console.warn('[iiko] customer sync failed:', e.message); }
    });
  }

  return { customer, isNew: true };
}

// Mavjud customer-ni iiko-ga sinxronlash (admin endpoint orqali chaqiriladi)
async function syncCustomerToIiko(telegramId) {
  if (!iiko.isConfigured() || !iiko.crmEnabled()) return { ok: false, reason: 'crm_disabled' };
  const customer = getCustomer(telegramId);
  if (!customer) return { ok: false, reason: 'not_found' };
  if (!customer.phone) return { ok: false, reason: 'no_phone' };
  try {
    const r = await iiko.customerCreateOrUpdate(customer);
    if (!r || !r.id) return { ok: false, reason: 'no_iiko_id', raw: r };
    db.prepare('UPDATE customers SET iiko_customer_id=? WHERE telegram_id=?').run(r.id, customer.telegram_id);
    if (customer.card_number) {
      try { await iiko.customerCardAdd(r.id, customer.card_number); } catch(e) {}
    }
    return { ok: true, iiko_id: r.id };
  } catch(e) {
    return { ok: false, reason: 'error', error: e.message };
  }
}

function creditBonus(telegramId, amount, reason, orderId) {
  if (amount <= 0) return;
  const tid = String(telegramId);
  const customer = getCustomer(tid);
  if (!customer) return;
  const expiresAt = new Date(Date.now() + BONUS_TTL_DAYS*24*3600*1000).toISOString().replace('T',' ').slice(0,19);
  db.prepare("INSERT INTO bonus_transactions (customer_telegram_id, amount, remaining, kind, reason, order_id, expires_at) VALUES (?, ?, ?, 'credit', ?, ?, ?)")
    .run(tid, amount, amount, reason, orderId, expiresAt);
  db.prepare('UPDATE customers SET bonus_balance=bonus_balance+?, total_earned=total_earned+? WHERE telegram_id=?')
    .run(amount, amount, tid);
}

function debitBonus(telegramId, amount, reason, orderId) {
  if (amount <= 0) return 0;
  const tid = String(telegramId);
  const customer = getCustomer(tid);
  if (!customer || customer.bonus_balance < amount) return 0;
  // FIFO: eskirmagan kreditlardan eski tartibda olamiz
  const credits = db.prepare("SELECT id, remaining FROM bonus_transactions WHERE customer_telegram_id=? AND kind='credit' AND remaining>0 AND (expires_at IS NULL OR expires_at>datetime('now')) ORDER BY created_at ASC").all(tid);
  let toSpend = amount;
  const updateRem = db.prepare('UPDATE bonus_transactions SET remaining=remaining-? WHERE id=?');
  for (const c of credits) {
    if (toSpend <= 0) break;
    const take = Math.min(toSpend, c.remaining);
    updateRem.run(take, c.id);
    toSpend -= take;
  }
  if (toSpend > 0) return 0; // theoretically unreachable
  db.prepare("INSERT INTO bonus_transactions (customer_telegram_id, amount, remaining, kind, reason, order_id) VALUES (?, ?, 0, 'debit', ?, ?)")
    .run(tid, amount, reason, orderId);
  db.prepare('UPDATE customers SET bonus_balance=bonus_balance-?, total_spent=total_spent+? WHERE telegram_id=?')
    .run(amount, amount, tid);
  return amount;
}

function expireBonuses() {
  // Eskirgan kreditlardan qolgan miqdorni balansdan ayirib, expire transaksiyasi yozamiz
  const rows = db.prepare("SELECT id, customer_telegram_id, remaining FROM bonus_transactions WHERE kind='credit' AND remaining>0 AND expires_at IS NOT NULL AND expires_at<=datetime('now')").all();
  for (const r of rows) {
    db.prepare('UPDATE bonus_transactions SET remaining=0 WHERE id=?').run(r.id);
    db.prepare("INSERT INTO bonus_transactions (customer_telegram_id, amount, remaining, kind, reason) VALUES (?, ?, 0, 'expire', 'ttl_expired')")
      .run(r.customer_telegram_id, r.remaining);
    db.prepare('UPDATE customers SET bonus_balance=bonus_balance-? WHERE telegram_id=?')
      .run(r.remaining, r.customer_telegram_id);
  }
  return rows.length;
}

// Har 30 daqiqada eskirgan bonuslarni tozalaymiz
setInterval(() => { try { expireBonuses(); } catch(e) {} }, 30*60*1000);

function maxBonusForOrder(orderTotal, customerBalance) {
  const cap = Math.floor(orderTotal * MAX_BONUS_USE_PERCENT / 100);
  return Math.max(0, Math.min(customerBalance, cap));
}

function bonusEarnedFor(order) {
  // Bonusdan to'langan qism uchun cashback berilmaydi
  const payable = (order.total || 0) - (order.bonus_used || 0);
  return Math.max(0, Math.floor(payable * BONUS_PERCENT / 100));
}

// ── IIKO SYNC ────────────────────────────────────────────────────────────────

async function syncIikoMenu() {
  if (!iiko.isConfigured()) return { ok: false, reason: 'not_configured' };

  let menuId = process.env.IIKO_EXTERNAL_MENU_ID;
  // Agar IIKO_EXTERNAL_MENU_ID env-da yo'q bo'lsa, birinchi mavjudini olamiz
  if (!menuId) {
    try {
      const list = await iiko.listExternalMenus();
      if (list.externalMenus && list.externalMenus.length > 0) {
        menuId = list.externalMenus[0].id;
      }
    } catch(e) {}
  }
  if (!menuId) return { ok: false, reason: 'no_external_menu' };

  const data = await iiko.getExternalMenu(menuId);
  const orgId = iiko.config.ORG_ID;
  const itemCategories = data.itemCategories || [];

  // Kategoriyalarni upsert
  const catIdByIiko = new Map();
  let order = 1;
  for (const g of itemCategories) {
    const name = (g.name || '').trim() || 'Menyu';
    const existing = db.prepare('SELECT id FROM categories WHERE iiko_group_id=?').get(g.id);
    if (existing) {
      db.prepare('UPDATE categories SET name_uz=?, name_ru=?, sort_order=?, active=1 WHERE id=?').run(name, name, order, existing.id);
      catIdByIiko.set(g.id, existing.id);
    } else {
      const r = db.prepare('INSERT INTO categories (name_uz, name_ru, emoji, sort_order, active, iiko_group_id) VALUES (?, ?, ?, ?, 1, ?)').run(name, name, '🍽', order, g.id);
      catIdByIiko.set(g.id, r.lastInsertRowid);
    }
    order++;
  }

  // Mahsulotlarni upsert
  let synced = 0;
  const allIikoIds = new Set();
  for (const g of itemCategories) {
    const categoryId = catIdByIiko.get(g.id);
    if (!categoryId) continue;
    const items = g.items || [];
    for (const it of items) {
      if (it.type !== 'DISH' && it.type !== 'GOOD' && it.type !== 'Dish' && it.type !== 'Good') continue;
      const size = (it.itemSizes && it.itemSizes[0]) || null;
      if (!size) continue;
      if (size.isHidden) continue;
      const priceObj = (size.prices || []).find(p => p.organizationId === orgId) || size.prices[0];
      if (!priceObj || !priceObj.price || priceObj.price <= 0) continue;

      const iikoId = it.itemId;
      allIikoIds.add(iikoId);
      const name = (it.name || '').trim();
      const desc = (it.description || '').trim();
      const image = size.buttonImageUrl || '';
      const price = Math.round(priceObj.price);

      const existing = db.prepare('SELECT id FROM products WHERE iiko_id=?').get(iikoId);
      if (existing) {
        db.prepare('UPDATE products SET name_uz=?, name_ru=?, desc_uz=?, desc_ru=?, price=?, category_id=?, image=COALESCE(NULLIF(?, ""), image), active=1, iiko_group_id=? WHERE id=?')
          .run(name, name, desc, desc, price, categoryId, image, g.id, existing.id);
      } else {
        db.prepare('INSERT INTO products (name_uz, name_ru, desc_uz, desc_ru, price, category_id, image, active, iiko_id, iiko_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
          .run(name, name, desc, desc, price, categoryId, image, iikoId, g.id);
      }
      synced++;
    }
  }

  // iiko-da yo'q bo'lgan eski iiko mahsulotlarini nofaol qilamiz
  let deactivated = 0;
  if (allIikoIds.size > 0) {
    const placeholders = Array.from(allIikoIds).map(() => '?').join(',');
    const r = db.prepare(`UPDATE products SET active=0 WHERE iiko_id IS NOT NULL AND iiko_id NOT IN (${placeholders})`).run(...Array.from(allIikoIds));
    deactivated = r.changes;
  }

  // Iiko-dagi guruhlardan yo'qolganlarni ham o'chiramiz
  const allGroupIds = itemCategories.map(g => g.id);
  if (allGroupIds.length > 0) {
    const ph = allGroupIds.map(() => '?').join(',');
    db.prepare(`UPDATE categories SET active=0 WHERE iiko_group_id IS NOT NULL AND iiko_group_id NOT IN (${ph})`).run(...allGroupIds);
  }

  // Seed (iiko_id NULL) kategoriyalarini o'chirish — replaceLocal flag bilan
  const replaceLocal = (process.env.IIKO_REPLACE_LOCAL_MENU || 'true').toLowerCase() === 'true';
  if (replaceLocal && synced >= 5) {
    db.prepare("UPDATE categories SET active=0 WHERE iiko_group_id IS NULL").run();
    db.prepare("UPDATE products SET active=0 WHERE iiko_id IS NULL").run();
  }

  return { ok: true, menu_id: menuId, groups: itemCategories.length, synced, deactivated, replaced_local: replaceLocal && synced>=5 };
}

// Buyurtmani iiko-ga yuborish
async function pushOrderToIiko(order, items) {
  if (!iiko.isConfigured()) return { skipped: 'not_configured' };
  // Mahsulotlar ichida iiko_id bor mahsulotlarni tanlaymiz
  const mapped = items.map(it => {
    const prod = db.prepare('SELECT iiko_id FROM products WHERE id=?').get(it.id);
    return { iikoProductId: prod && prod.iiko_id || null, amount: it.qty, comment: it.name_uz };
  }).filter(x => x.iikoProductId);
  if (mapped.length === 0) return { skipped: 'no_iiko_items' };

  try {
    const r = await iiko.createDelivery({
      phone: order.user_phone || '',
      customerName: order.user_name || '',
      items: mapped,
      comment: '🎫 Karta: '+(order.card_number||'-')+'\n'+(order.comment || ''),
      address: order.address || '',
      deliveryType: order.delivery_type === 'pickup' ? 'pickup' : 'delivery'
    });
    return { ok: true, orderId: r && r.orderInfo && r.orderInfo.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── BOT ──────────────────────────────────────────────────────────────────────

bot.start(async ctx => {
  const id = String(ctx.from.id);
  db.prepare('INSERT OR IGNORE INTO users (telegram_id,first_name,last_name,username) VALUES (?,?,?,?)').run(id, ctx.from.first_name, ctx.from.last_name||'', ctx.from.username||'');

  // Admin va kuryerlar — alohida flow
  if (ADMIN_IDS.includes(id)) {
    db.prepare("UPDATE users SET role='admin' WHERE telegram_id=?").run(id);
    await ctx.reply('Salom, '+ctx.from.first_name+'! 👋', Markup.removeKeyboard()).catch(()=>{});
    return ctx.reply('Admin panelga xush kelibsiz!', Markup.inlineKeyboard([
      [Markup.button.webApp('📊 Admin Panel', APP_URL+'/admin.html?uid='+id)]
    ]));
  }
  if (COURIER_IDS.includes(id)) {
    db.prepare("UPDATE users SET role='courier' WHERE telegram_id=?").run(id);
    await ctx.reply('Salom, '+ctx.from.first_name+'! 👋', Markup.removeKeyboard()).catch(()=>{});
    return ctx.reply('Kuryer paneliga xush kelibsiz!', Markup.inlineKeyboard([
      [Markup.button.webApp('🛵 Buyurtmalarim', APP_URL+'/courier.html?uid='+id)]
    ]));
  }

  // Oddiy mijoz: ro'yxatdan o'tganmi tekshiramiz
  const customer = getCustomer(id);
  if (!customer) {
    return ctx.reply(
      '🍔 Buono Burger ga xush kelibsiz!\n\nRo\'yxatdan o\'tib, sizga maxsus karta va '+WELCOME_BONUS.toLocaleString()+" so'm sovg'a bonus beramiz!\n\nIltimos telefon raqamingizni yuboring:",
      {
        reply_markup: {
          keyboard: [[{text: "📞 Telefon raqamni yuborish", request_contact: true}]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
  }

  // Mavjud mijoz: karta ma'lumotlari + tugmalar
  await ctx.reply('Salom, '+ctx.from.first_name+'! 👋', Markup.removeKeyboard()).catch(()=>{});
  return showCustomerHome(ctx, customer);
});

async function showCustomerHome(ctx, customer) {
  const greeting = '🍔 Buono Burger\n\n'+
    '🎫 Karta raqami: <code>'+customer.card_number+'</code>\n'+
    '💰 Bonus balans: <b>'+customer.bonus_balance.toLocaleString()+" so'm</b>\n\n"+
    '⏰ Ish vaqti: 10:00–23:00';
  return ctx.reply(greeting, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.webApp('🛒 Menyuni ochish', APP_URL+'/index.html')],
      [Markup.button.webApp('🎫 Mening kartam', APP_URL+'/index.html#card')],
      [Markup.button.callback('⭐ Baho berish', 'fb_main')]
    ]).reply_markup
  });
}

// Ro'yxatdan o'tish bosqichlari (telefon → ism → familiya)
const pendingRegistration = new Map();
const REG = { ASK_FIRST_NAME: 'first_name', ASK_LAST_NAME: 'last_name' };

function setReg(uid, patch) {
  const cur = pendingRegistration.get(uid) || {};
  pendingRegistration.set(uid, Object.assign(cur, patch));
}
function clearReg(uid) { pendingRegistration.delete(uid); }
function getReg(uid) { return pendingRegistration.get(uid); }

// 1-bosqich: Telefon raqami olinganda — ismni so'raymiz
bot.on('contact', async ctx => {
  try {
    const id = String(ctx.from.id);
    const contact = ctx.message.contact;
    if (String(contact.user_id) !== id) {
      return ctx.reply("❌ Iltimos o'z telefon raqamingizni yuboring.");
    }
    const phone = contact.phone_number;

    // Mavjud bo'lsa — to'g'ridan-to'g'ri uy sahifasi
    const existing = getCustomer(id);
    if (existing) {
      if (phone && phone !== existing.phone) {
        db.prepare('UPDATE customers SET phone=? WHERE telegram_id=?').run(phone, id);
      }
      await ctx.reply('✅ Siz allaqachon ro\'yxatdan o\'tgansiz.', { reply_markup: { remove_keyboard: true } });
      return showCustomerHome(ctx, getCustomer(id));
    }

    // Pending registration boshlanmoqda — telefonni saqlab, ismni so'raymiz
    setReg(id, { step: REG.ASK_FIRST_NAME, phone, username: ctx.from.username || '' });
    await ctx.reply("✅ Telefon raqam qabul qilindi.\n\n👤 Endi <b>ism</b>ingizni yozing:", {
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true }
    });
  } catch(e) { console.error('contact error:', e.message); }
});

bot.command('karta', async ctx => {
  const id = String(ctx.from.id);
  const customer = getCustomer(id);
  if (!customer) return ctx.reply("Iltimos /start bosing va ro'yxatdan o'ting.");
  return showCustomerHome(ctx, customer);
});

// ── FEEDBACK (buonoFB_bot dan ko'chirildi) ───────────────────────────────────

const feedbackState = new Map();

function getShift() {
  // UTC+5 (Toshkent)
  const now = new Date(Date.now() + 5*3600*1000);
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const mins = h*60 + m;
  if (mins >= 9*60 && mins < 18*60+30) return 'smena1';
  return 'smena2';
}
function shiftLabel(s) {
  return s === 'smena1' ? "1-smena (09:00-18:30)" : "2-smena (18:30-04:00)";
}
function setFb(uid, patch) {
  const cur = feedbackState.get(uid) || {};
  feedbackState.set(uid, Object.assign(cur, patch));
}
function clearFb(uid) { feedbackState.delete(uid); }
function getFb(uid) { return feedbackState.get(uid); }

function feedbackMainKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Baho berish', 'fb_rating')],
    [Markup.button.callback('💡 Taklif yuborish', 'fb_sugg')],
    [Markup.button.callback('😡 Shikoyat yuborish', 'fb_comp')],
  ]);
}
function ratingKb(prefix, backCb) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⭐', prefix+'_1'),
      Markup.button.callback('⭐⭐', prefix+'_2'),
      Markup.button.callback('⭐⭐⭐', prefix+'_3'),
    ],
    [
      Markup.button.callback('⭐⭐⭐⭐', prefix+'_4'),
      Markup.button.callback('⭐⭐⭐⭐⭐', prefix+'_5'),
    ],
    [Markup.button.callback('⬅️ Ortga', backCb)],
  ]);
}
function backKb(cb) {
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ Ortga', cb)]]);
}
function commentChoiceKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💬 Izoh qoldirish', 'fb_iz_yes')],
    [Markup.button.callback('⏭ Izohsiz yakunlash', 'fb_iz_no')],
    [Markup.button.callback('⬅️ Ortga', 'fb_back_tz')],
  ]);
}
function restartKb() {
  return Markup.inlineKeyboard([[Markup.button.callback('🔄 Yangi fikr bildirish', 'fb_main')]]);
}

async function safeEdit(ctx, text, kb) {
  try { await ctx.editMessageText(text, kb); }
  catch(e) { try { await ctx.reply(text, kb); } catch(_){} }
}

bot.action('fb_main', async ctx => {
  await ctx.answerCbQuery();
  clearFb(String(ctx.from.id));
  await safeEdit(ctx, "👋 Fikr-mulohaza bo'limi.\nBo'limni tanlang:", feedbackMainKb());
});

bot.action('fb_rating', async ctx => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  const prev = getFb(uid) || {};
  setFb(uid, {category:'rating', orderId: prev.orderId||null, kassir:null, taom:null, tozalik:null, awaitingText:false});
  await safeEdit(ctx, '⭐ 1/3 — Kassir muomalasini baholang:', ratingKb('fb_k', 'fb_main'));
});

for (let i=1;i<=5;i++) {
  bot.action('fb_k_'+i, async ctx => {
    await ctx.answerCbQuery();
    setFb(String(ctx.from.id), {kassir: i});
    await safeEdit(ctx, '🍔 2/3 — Taom mazasini baholang:', ratingKb('fb_t', 'fb_back_k'));
  });
  bot.action('fb_t_'+i, async ctx => {
    await ctx.answerCbQuery();
    setFb(String(ctx.from.id), {taom: i});
    await safeEdit(ctx, '🧹 3/3 — Tozalikni baholang:', ratingKb('fb_tz', 'fb_back_t'));
  });
  bot.action('fb_tz_'+i, async ctx => {
    await ctx.answerCbQuery();
    setFb(String(ctx.from.id), {tozalik: i});
    await safeEdit(ctx, "✅ Baholaringiz qabul qilindi!\n\nIzoh qoldirishni xohlaysizmi?", commentChoiceKb());
  });
}
bot.action('fb_back_k', async ctx => {
  await ctx.answerCbQuery();
  await safeEdit(ctx, '⭐ 1/3 — Kassir muomalasini baholang:', ratingKb('fb_k', 'fb_main'));
});
bot.action('fb_back_t', async ctx => {
  await ctx.answerCbQuery();
  await safeEdit(ctx, '🍔 2/3 — Taom mazasini baholang:', ratingKb('fb_t', 'fb_back_k'));
});
bot.action('fb_back_tz', async ctx => {
  await ctx.answerCbQuery();
  await safeEdit(ctx, '🧹 3/3 — Tozalikni baholang:', ratingKb('fb_tz', 'fb_back_t'));
});

bot.action('fb_iz_no', async ctx => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  const state = getFb(uid);
  if (!state) return;
  await finalizeFeedback(ctx, state, '', '');
  clearFb(uid);
  await safeEdit(ctx, "✅ Izohingiz biz uchun qadrli va rivojlanishimiz uchun katta qadam! Rahmat! 😊", restartKb());
});
bot.action('fb_iz_yes', async ctx => {
  await ctx.answerCbQuery();
  setFb(String(ctx.from.id), {awaitingText:true});
  await safeEdit(ctx, "💬 Izohingizni yozing yoki rasm yuboring:", backKb('fb_back_iz'));
});
bot.action('fb_back_iz', async ctx => {
  await ctx.answerCbQuery();
  setFb(String(ctx.from.id), {awaitingText:false});
  await safeEdit(ctx, "✅ Baholaringiz qabul qilindi!\n\nIzoh qoldirishni xohlaysizmi?", commentChoiceKb());
});

bot.action('fb_sugg', async ctx => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  const prev = getFb(uid) || {};
  setFb(uid, {category:'suggestion', orderId: prev.orderId||null, awaitingText:true});
  await safeEdit(ctx, '💡 Taklifingizni yozing:\n\n(Matn yoki rasm yuborishingiz mumkin)', backKb('fb_main'));
});
bot.action('fb_comp', async ctx => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  const prev = getFb(uid) || {};
  setFb(uid, {category:'complaint', orderId: prev.orderId||null, awaitingText:true});
  await safeEdit(ctx, '😡 Shikoyatingizni yozing:\n\n(Matn yoki rasm yuborishingiz mumkin)', backKb('fb_main'));
});

// Post-delivery: buyurtma ID bilan to'g'ridan-to'g'ri rating/sugg/comp ga o'tish
bot.action(/^fb_or_(\d+)_(rating|sugg|comp)$/, async ctx => {
  await ctx.answerCbQuery();
  const uid = String(ctx.from.id);
  const orderId = parseInt(ctx.match[1]);
  const type = ctx.match[2];
  if (type === 'rating') {
    setFb(uid, {category:'rating', orderId, kassir:null, taom:null, tozalik:null, awaitingText:false});
    await safeEdit(ctx, '⭐ 1/3 — Kassir muomalasini baholang:', ratingKb('fb_k', 'fb_main'));
  } else if (type === 'sugg') {
    setFb(uid, {category:'suggestion', orderId, awaitingText:true});
    await safeEdit(ctx, '💡 Taklifingizni yozing:\n\n(Matn yoki rasm yuborishingiz mumkin)', backKb('fb_main'));
  } else {
    setFb(uid, {category:'complaint', orderId, awaitingText:true});
    await safeEdit(ctx, '😡 Shikoyatingizni yozing:\n\n(Matn yoki rasm yuborishingiz mumkin)', backKb('fb_main'));
  }
});

bot.on('text', async ctx => {
  const uid = String(ctx.from.id);
  const txt = (ctx.message.text || '').trim();

  // Ro'yxatdan o'tish bosqichlari — telefondan keyin ism va familiya
  const reg = getReg(uid);
  if (reg && reg.step) {
    // /komandalarni qabul qilmaymiz registratsiya paytida
    if (txt.startsWith('/')) {
      return ctx.reply("Iltimos ro'yxatdan o'tishni yakunlang yoki /start bilan qaytadan boshlang.");
    }
    if (reg.step === REG.ASK_FIRST_NAME) {
      if (txt.length < 2 || txt.length > 40) {
        return ctx.reply("❌ Iltimos to'g'ri ism kiriting (2–40 ta harf).");
      }
      setReg(uid, { step: REG.ASK_LAST_NAME, first_name: txt });
      return ctx.reply("✅ Ism qabul qilindi.\n\n👤 Endi <b>familiya</b>ngizni yozing:", { parse_mode: 'HTML' });
    }
    if (reg.step === REG.ASK_LAST_NAME) {
      if (txt.length < 2 || txt.length > 40) {
        return ctx.reply("❌ Iltimos to'g'ri familiya kiriting (2–40 ta harf). Familiyangiz bo'lmasa nuqta (.) qo'ying.");
      }
      // To'liq ma'lumot bilan ro'yxatdan o'tkazamiz
      const state = reg;
      clearReg(uid);
      const { customer, isNew } = registerCustomer(uid, state.first_name, txt, state.username || ctx.from.username || '', state.phone);
      await ctx.reply(
        '✅ <b>Ro\'yxatdan muvaffaqiyatli o\'tdingiz!</b>\n\n'+
          '👤 Ism: '+state.first_name+' '+txt+'\n'+
          '📞 Telefon: '+state.phone+'\n'+
          '🎫 Karta raqami: <code>'+customer.card_number+'</code>\n'+
          '🎁 Sovg\'a bonus: <b>'+WELCOME_BONUS.toLocaleString()+" so'm</b>\n"+
          '📅 Bonus muddati: '+BONUS_TTL_DAYS+' kun\n\n'+
          'Ma\'lumotlaringiz iiko mijozlar bazasiga saqlandi.',
        { parse_mode: 'HTML' }
      );
      return showCustomerHome(ctx, getCustomer(uid));
    }
  }

  // Feedback flow (mavjud)
  const state = getFb(uid);
  if (!state || !state.awaitingText) return;
  await finalizeFeedback(ctx, state, txt, '');
  clearFb(uid);
  await ctx.reply("✅ Izohingiz biz uchun qadrli va rivojlanishimiz uchun katta qadam! Rahmat! 😊", restartKb());
});

bot.on('photo', async ctx => {
  const uid = String(ctx.from.id);
  const state = getFb(uid);
  if (!state || !state.awaitingText) return;
  const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
  const caption = ctx.message.caption || '';
  await finalizeFeedback(ctx, state, caption, fileId);
  clearFb(uid);
  await ctx.reply("✅ Izohingiz biz uchun qadrli va rivojlanishimiz uchun katta qadam! Rahmat! 😊", restartKb());
});

async function finalizeFeedback(ctx, state, comment, photoFileId) {
  const u = ctx.from;
  const username = u.username ? '@'+u.username : "yo'q";
  const fullName = ((u.first_name||'')+' '+(u.last_name||'')).trim();
  const shift = getShift();
  const cat = state.category;

  db.prepare(
    'INSERT INTO feedback (user_id,user_name,username,category,kassir,taom,tozalik,comment,photo_file_id,shift,order_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    String(u.id), fullName, u.username||'',
    cat,
    state.kassir||null, state.taom||null, state.tozalik||null,
    comment||'', photoFileId||'', shift, state.orderId||null
  );

  const icons = {rating:'⭐', suggestion:'💡', complaint:'😡'};
  const names = {rating:'BAHO', suggestion:'TAKLIF', complaint:'SHIKOYAT'};
  let msg = icons[cat]+' *YANGI '+names[cat]+'*\n';
  msg += '🕐 '+shiftLabel(shift)+'\n\n';
  msg += '👤 '+fullName+' ('+username+')\n🆔 `'+u.id+'`\n';
  if (cat==='rating') {
    msg += '\n⭐ Kassir muomalasi: '+'⭐'.repeat(state.kassir)+' ('+state.kassir+'/5)\n';
    msg += '🍔 Taom mazasi: '+'⭐'.repeat(state.taom)+' ('+state.taom+'/5)\n';
    msg += '🧹 Tozalik: '+'⭐'.repeat(state.tozalik)+' ('+state.tozalik+'/5)\n';
  }
  if (state.orderId) msg += '\n📦 Buyurtma #'+state.orderId;
  if (comment) msg += '\n💬 '+comment;

  // Buyurtmaga bog'liq baho/taklif/shikoyat → buyurtmalar guruhi
  // Oddiy (buyurtmasiz) — feedback guruhi
  const recipients = state.orderId ? orderRecipients() : generalFeedbackRecipients();
  for (const id of recipients) {
    try {
      if (photoFileId) {
        await bot.telegram.sendPhoto(id, photoFileId, {caption: msg, parse_mode: 'Markdown'});
      } else {
        await bot.telegram.sendMessage(id, msg, {parse_mode: 'Markdown'});
      }
    } catch(e) {}
  }
}

function buildStatsReport(title) {
  const now = new Date();
  const months = ['Yanvar','Fevral','Mart','Aprel','May','Iyun','Iyul','Avgust','Sentabr','Oktabr','Noyabr','Dekabr'];
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const rows = db.prepare("SELECT * FROM feedback WHERE created_at >= ?").all(monthStart);
  const labels = {smena1: '1-smena (09:00–18:30)', smena2: '2-smena (18:30–04:00)'};

  let report = '📊 *'+title+' — '+months[now.getMonth()]+' '+now.getFullYear()+'*\n\n';

  for (const s of ['smena1','smena2']) {
    const sr = rows.filter(r => r.shift === s);
    const ratings = sr.filter(r => r.category === 'rating');
    const suggCount = sr.filter(r => r.category === 'suggestion').length;
    const compCount = sr.filter(r => r.category === 'complaint').length;

    const sumAvg = field => {
      const vals = ratings.map(r => r[field]).filter(v => v);
      if (!vals.length) return [0, 0];
      const sum = vals.reduce((a,b)=>a+b,0);
      return [Math.round(sum/vals.length*10)/10, vals.length];
    };
    const counts = field => {
      const c = [0,0,0,0,0,0];
      for (const r of ratings) if (r[field]) c[r[field]]++;
      return c;
    };
    const [kAvg, kTot] = sumAvg('kassir');
    const [tAvg] = sumAvg('taom');
    const [zAvg] = sumAvg('tozalik');
    const kC = counts('kassir'), tC = counts('taom'), zC = counts('tozalik');

    report += '🔷 *'+labels[s]+'*\n';
    report += '⭐ *Baholar: '+kTot+' ta*\n';
    report += '  Kassir: '+kAvg+'/5\n';
    for (let i=1;i<=5;i++) report += '    '+'⭐'.repeat(i)+' — '+kC[i]+' ta\n';
    report += '  Taom: '+tAvg+'/5\n';
    for (let i=1;i<=5;i++) report += '    '+'⭐'.repeat(i)+' — '+tC[i]+' ta\n';
    report += '  Tozalik: '+zAvg+'/5\n';
    for (let i=1;i<=5;i++) report += '    '+'⭐'.repeat(i)+' — '+zC[i]+' ta\n';
    report += '💡 Takliflar: '+suggCount+' ta\n';
    report += '😡 Shikoyatlar: '+compCount+' ta\n\n';
  }
  return report;
}

bot.command('statistika', async ctx => {
  const id = String(ctx.from.id);
  if (!ADMIN_IDS.includes(id)) return;
  await ctx.reply(buildStatsReport('STATISTIKA'), {parse_mode: 'Markdown'});
});

// Guruh ID-sini topish uchun yordamchi komanda
bot.command('chatid', async ctx => {
  try {
    const c = ctx.chat;
    rememberChat(c);
    const text = '🆔 *Chat ma\'lumotlari*\n\n'+
      'ID: `'+c.id+'`\n'+
      'Turi: '+c.type+'\n'+
      (c.title?'Nomi: '+c.title+'\n':'')+
      (c.username?'Username: @'+c.username+'\n':'')+
      '\nShu ID-ni Railway Variables ga qo\'ying:\n'+
      '`ORDERS_GROUP_ID` (buyurtmalar uchun)\n'+
      '`FEEDBACK_GROUP_ID` (taklif/shikoyatlar uchun)';
    await ctx.reply(text, {parse_mode: 'Markdown'});
  } catch(e) {}
});

function rememberChat(chat) {
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup' && chat.type !== 'channel')) return;
  try {
    db.prepare('INSERT OR REPLACE INTO chats (id,title,type,username,added_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)')
      .run(String(chat.id), chat.title||'', chat.type, chat.username||'');
  } catch(e) {}
}

// Bot guruhga qo'shilganda / olib tashlanganda avtomatik saqlash
bot.on('my_chat_member', async ctx => {
  try {
    const chat = ctx.chat;
    const newStatus = ctx.update.my_chat_member?.new_chat_member?.status;
    if (chat.type !== 'group' && chat.type !== 'supergroup' && chat.type !== 'channel') return;
    if (['member','administrator','creator'].includes(newStatus)) {
      rememberChat(chat);
    } else if (newStatus === 'left' || newStatus === 'kicked') {
      try { db.prepare('DELETE FROM chats WHERE id=?').run(String(chat.id)); } catch(e) {}
    }
  } catch(e) {}
});

// Oylik avto-hisobot (har soat tekshiriladi, har oyning 1-kunida 09:00 da yuboriladi)
const monthlyReportSent = new Set();
setInterval(async () => {
  try {
    const now = new Date(Date.now() + 5*3600*1000);
    if (now.getUTCDate() !== 1 || now.getUTCHours() !== 9) return;
    const key = 'monthly_'+now.getUTCFullYear()+'_'+now.getUTCMonth();
    if (monthlyReportSent.has(key)) return;
    monthlyReportSent.add(key);
    const text = buildStatsReport('OYLIK HISOBOT');
    for (const id of generalFeedbackRecipients()) {
      try { await bot.telegram.sendMessage(id, text, {parse_mode: 'Markdown'}); } catch(e) {}
    }
  } catch(e) { console.error('Monthly report error:', e.message); }
}, 60*1000);

// ── HELPERS ───────────────────────────────────────────────────────────────────

function paymentLabel(order) {
  const method = order.payment==='cash' ? "Naqd" : order.payment==='click' ? "Click" : "Payme";
  if (order.payment==='cash') return "💵 Naqd (yetkazganda to'lanadi)";
  if (order.payment_status==='paid') return "✅ "+method+" — To'langan";
  if (order.payment_status==='rejected') return "❌ "+method+" — To'lov amalga oshmadi";
  return "⏳ "+method+" — To'lov kutilmoqda";
}

function notifyAdmin(order) {
  const items = JSON.parse(order.items);
  let t = '🆕 YANGI BUYURTMA #'+order.id+'\n\n';
  t += (order.user_name||'-')+' | '+(order.user_phone||'-')+'\n';
  items.forEach(i => { t += '▪ '+i.name_uz+' × '+i.qty+' = '+(i.price*i.qty).toLocaleString()+" so'm\n"; });
  t += '\nJami: '+order.total.toLocaleString()+" so'm";
  t += '\n'+paymentLabel(order);
  if (order.comment) t += '\n💬 '+order.comment;
  if (order.address) t += '\n📍 '+order.address;

  orderRecipients().forEach(id => {
    bot.telegram.sendMessage(id, t).catch(()=>{});
    if (order.lat && order.lng) {
      bot.telegram.sendLocation(id, order.lat, order.lng).catch(()=>{});
    }
  });
}

function notifyCourier(courierId, order) {
  const items = JSON.parse(order.items);
  let t = '🛵 Buyurtma #'+order.id+' tayinlandi!\n\n';
  t += (order.user_name||'-')+'\n'+(order.user_phone||'-')+'\n';
  if (order.address) t += '📍 '+order.address+'\n';
  t += items.map(i => i.name_uz+' × '+i.qty).join(', ')+'\nJami: '+order.total.toLocaleString()+" so'm";
  bot.telegram.sendMessage(courierId, t).catch(()=>{});
  if (order.lat && order.lng) bot.telegram.sendLocation(courierId, order.lat, order.lng).catch(()=>{});
}

function notifyCustomer(order) {
  const m = {
    accepted: '✅ Buyurtmangiz qabul qilindi!',
    cooking: '👨‍🍳 Buyurtmangiz tayyorlanmoqda...',
    on_way: "🛵 Kuryer yo'lda! Tez orada yetkaziladi.",
    delivered: '🎉 Buyurtma yetkazildi! Rahmat!'
  };
  if (!m[order.status]) return;
  let msg = m[order.status];
  // Taxminiy yetkazib berish vaqti — qabul qilingan va tayyorlanmoqda statuslarida
  if (order.status === 'accepted' || order.status === 'cooking') {
    msg += "\n\n⏰ Taxminiy yetkazib berish: " + estimatedDeliveryText();
  }
  if (order.status==='on_way' || order.status==='delivered') {
    msg += "\n\n💳 To'lov: "+paymentLabel(order);
  }

  // Yetkazilganda — cashback hisoblash
  if (order.status === 'delivered' && order.user_id && order.user_id !== 'anon' && !order.cashback_credited) {
    const eligible = order.payment === 'cash' || order.payment_status === 'paid';
    if (eligible) {
      const cashback = bonusEarnedFor(order);
      if (cashback > 0 && getCustomer(order.user_id)) {
        creditBonus(order.user_id, cashback, 'order_cashback', order.id);
        db.prepare('UPDATE orders SET cashback_credited=1 WHERE id=?').run(order.id);
        const cust = getCustomer(order.user_id);
        msg += '\n\n💰 Buyurtmangiz uchun <b>+'+cashback.toLocaleString()+" so'm</b> bonus hisoblandi.\nJoriy balans: <b>"+cust.bonus_balance.toLocaleString()+" so'm</b>";
      }
    }
  }

  bot.telegram.sendMessage(order.user_id, msg, {parse_mode: 'HTML'}).catch(()=>{});

  // Yetkazilgandan keyin baho so'rash (rasmda ko'rsatilganidek 3 ta tugma)
  if (order.status === 'delivered' && order.user_id && order.user_id !== 'anon' && !order.feedback_sent) {
    db.prepare('UPDATE orders SET feedback_sent=1 WHERE id=?').run(order.id);
    setTimeout(() => {
      bot.telegram.sendMessage(
        order.user_id,
        "🙏 Buyurtmangizdan mamnunmisiz?\nIltimos, fikr-mulohaza bildiring:",
        Markup.inlineKeyboard([
          [Markup.button.callback('⭐ Baho berish', 'fb_or_'+order.id+'_rating')],
          [Markup.button.callback('💡 Taklif yuborish', 'fb_or_'+order.id+'_sugg')],
          [Markup.button.callback('😡 Shikoyat yuborish', 'fb_or_'+order.id+'_comp')],
        ])
      ).catch(()=>{});
    }, 2000);
  }
}

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/menu', (req, res) => {
  const cats = db.prepare('SELECT * FROM categories WHERE active=1 ORDER BY sort_order').all();
  const prods = db.prepare('SELECT * FROM products WHERE active=1').all();
  cats.forEach(c => { c.products = prods.filter(p => p.category_id===c.id); });
  res.json(cats);
});

app.post('/api/user', (req, res) => {
  const { telegram_id, first_name, last_name, username } = req.body;
  if (!telegram_id) return res.json({});
  db.prepare('INSERT OR IGNORE INTO users (telegram_id,first_name,last_name,username) VALUES (?,?,?,?)').run(telegram_id, first_name, last_name||'', username||'');
  if (ADMIN_IDS.includes(String(telegram_id))) db.prepare("UPDATE users SET role='admin' WHERE telegram_id=?").run(telegram_id);
  else if (COURIER_IDS.includes(String(telegram_id))) db.prepare("UPDATE users SET role='courier' WHERE telegram_id=?").run(telegram_id);
  res.json(db.prepare('SELECT * FROM users WHERE telegram_id=?').get(telegram_id));
});

app.post('/api/orders', async (req, res) => {
  const { user_id, user_name, user_phone, items, total, address, lat, lng, comment, payment } = req.body;
  let bonusUsed = Math.max(0, parseInt(req.body.bonus_used || 0) || 0);
  const deliveryType = req.body.delivery_type === 'pickup' ? 'pickup' : 'delivery';

  const allowed = ['cash', 'click', 'payme'];
  if (!allowed.includes(payment)) return res.status(400).json({ error: 'Invalid payment method' });

  // Yetkazib berish radiusi tekshiruvi (faqat delivery uchun)
  if (deliveryType === 'delivery') {
    if (typeof lat === 'number' && typeof lng === 'number') {
      const distance = haversineKm(RESTAURANT_LAT, RESTAURANT_LNG, lat, lng);
      if (distance > DELIVERY_RADIUS_KM) {
        return res.status(400).json({ error: "Manzilingiz "+distance.toFixed(1)+" km uzoqlikda. Bizning yetkazib berish radiusimiz "+DELIVERY_RADIUS_KM+" km. O'zi olib ketishni tanlashingiz mumkin." });
      }
    }
  }

  // Bonus ishlatish — validatsiya
  if (bonusUsed > 0) {
    const customer = getCustomer(user_id);
    if (!customer) return res.status(400).json({ error: 'Bonus ishlatish uchun ro\'yxatdan o\'ting' });
    const allowedMax = maxBonusForOrder(total, customer.bonus_balance);
    if (bonusUsed > allowedMax) return res.status(400).json({ error: "Bonus limiti oshib ketdi. Maksimum: "+allowedMax.toLocaleString()+" so'm" });
  }

  const r = db.prepare('INSERT INTO orders (user_id,user_name,user_phone,items,total,address,lat,lng,comment,payment,bonus_used) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(user_id, user_name, user_phone, JSON.stringify(items), total, address, lat, lng, comment, payment, bonusUsed);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);

  if (bonusUsed > 0) {
    debitBonus(user_id, bonusUsed, 'order_spend', order.id);
  }

  notifyAdmin(order);

  // iiko-ga buyurtma yuborish (fonda)
  if (iiko.isConfigured()) {
    const customer = getCustomer(user_id);
    const itemsArr = JSON.parse(order.items);
    setImmediate(async () => {
      try {
        const result = await pushOrderToIiko({
          user_name: order.user_name,
          user_phone: order.user_phone,
          address: order.address,
          comment: order.comment,
          delivery_type: order.delivery_type,
          card_number: customer && customer.card_number
        }, itemsArr);
        if (result.ok && result.orderId) {
          db.prepare('UPDATE orders SET iiko_order_id=? WHERE id=?').run(result.orderId, order.id);
        } else if (result.error) {
          db.prepare('UPDATE orders SET iiko_sync_error=? WHERE id=?').run(result.error.slice(0, 250), order.id);
          console.warn('[iiko] order#'+order.id+' sync failed:', result.error);
        }
      } catch(e) { console.warn('[iiko] push exception:', e.message); }
    });
  }

  res.json({
    ok: true,
    order_id: r.lastInsertRowid,
    eta_text: estimatedDeliveryText(),
    eta_window: estimatedDeliveryWindow()
  });
});

// Mini app uchun konfiguratsiya (radius, restoran manzil, ETA)
app.get('/api/config', (req, res) => {
  res.json({
    restaurant_lat: RESTAURANT_LAT,
    restaurant_lng: RESTAURANT_LNG,
    restaurant_address: RESTAURANT_ADDRESS,
    delivery_radius_km: DELIVERY_RADIUS_KM,
    eta_min_minutes: ETA_MIN_MINUTES,
    eta_max_minutes: ETA_MAX_MINUTES,
    bonus_percent: BONUS_PERCENT,
    welcome_bonus: WELCOME_BONUS,
    bonus_ttl_days: BONUS_TTL_DAYS,
    max_bonus_use_percent: MAX_BONUS_USE_PERCENT
  });
});

// Admin: foydalanuvchilarga ommaviy xabar yuborish
// Fonda ishlaydi — Railway 60s edge timeout-iga tushib qolmaslik uchun.
const broadcastJobs = new Map();
app.post('/api/admin/broadcast', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const message = (req.body && req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: "Xabar bo'sh" });

  // Telegram identifiers — har qanday tanish manbalardan to'planadi
  const ids = new Set();
  try {
    db.prepare("SELECT telegram_id FROM customers WHERE telegram_id IS NOT NULL").all().forEach(r => r.telegram_id && ids.add(String(r.telegram_id)));
  } catch(e) {}
  try {
    db.prepare("SELECT telegram_id FROM users WHERE role IS NULL OR role='customer'").all().forEach(r => r.telegram_id && ids.add(String(r.telegram_id)));
  } catch(e) {}
  const recipients = Array.from(ids);

  const jobId = String(Date.now()) + '_' + Math.random().toString(36).slice(2,8);
  const job = { id: jobId, total: recipients.length, sent: 0, failed: 0, done: false, started: new Date().toISOString() };
  broadcastJobs.set(jobId, job);

  // Foydalanuvchiga darhol javob qaytaramiz
  res.json({ ok: true, job_id: jobId, total: recipients.length, sent: 0, failed: 0, accepted: true });

  // Fonda yuborish
  (async () => {
    for (const tid of recipients) {
      try {
        await bot.telegram.sendMessage(tid, message);
        job.sent++;
      } catch(e) {
        job.failed++;
      }
      // Telegram rate-limit (~30 msg/sec): xavfsiz 40ms pauza
      await new Promise(r => setTimeout(r, 40));
    }
    job.done = true;
    job.finished = new Date().toISOString();
    // 30 daqiqadan keyin map'dan tozalash
    setTimeout(() => broadcastJobs.delete(jobId), 30*60*1000);
  })().catch(e => { job.error = e.message; job.done = true; });
});

app.get('/api/admin/broadcast/:jobId', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const job = broadcastJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Admin: Mavjud mijozlarni iiko-ga ommaviy sinxronlash
app.post('/api/admin/iiko/sync-customers', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  if (!iiko.isConfigured() || !iiko.crmEnabled()) {
    return res.status(400).json({ error: 'iiko CRM disabled' });
  }
  const customers = db.prepare("SELECT telegram_id, phone, card_number, iiko_customer_id FROM customers WHERE phone IS NOT NULL AND phone != ''").all();
  const toSync = customers.filter(c => !c.iiko_customer_id);
  res.json({ ok: true, total: customers.length, to_sync: toSync.length, accepted: true });

  // Fonda sinxronlash
  (async () => {
    let ok = 0, fail = 0;
    for (const c of toSync) {
      try {
        const r = await syncCustomerToIiko(c.telegram_id);
        if (r.ok) ok++; else fail++;
      } catch(e) { fail++; }
      await new Promise(r => setTimeout(r, 200));
    }
    console.log('[iiko] bulk customer sync done:', { ok, fail, total: toSync.length });
  })().catch(e => console.error('[iiko] bulk sync error:', e.message));
});

// Admin: iiko menyusini qo'lda sinxronlash
app.post('/api/admin/iiko/sync-menu', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  if (!iiko.isConfigured()) return res.status(400).json({ error: 'iiko not configured' });
  try {
    const result = await syncIikoMenu();
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: iiko ulanish holati va konfiguratsiya
app.get('/api/admin/iiko/status', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const out = {
    configured: iiko.isConfigured(),
    crm_enabled: iiko.crmEnabled(),
    organization_id: iiko.config.ORG_ID || null,
    terminal_group_id: iiko.config.TERMINAL_GROUP_ID || null,
    external_menu_id: process.env.IIKO_EXTERNAL_MENU_ID || null
  };
  if (out.configured) {
    try { await iiko.getToken(); out.token_ok = true; }
    catch(e) { out.token_ok = false; out.token_error = e.message; }
    // Diagnostika: nomenclature, list menus, external menu
    try {
      const noms = await iiko.getNomenclature();
      out.nomenclature_ok = true;
      out.nomenclature_products = (noms.products||[]).length;
    } catch(e) { out.nomenclature_ok = false; out.nomenclature_error = (e.message||'').slice(0,300); }
    try {
      const list = await iiko.listExternalMenus();
      out.menus_ok = true;
      out.menus = (list.externalMenus||[]).map(m => ({id:m.id, name:m.name}));
    } catch(e) { out.menus_ok = false; out.menus_error = (e.message||'').slice(0,300); }
    try {
      const menuId = process.env.IIKO_EXTERNAL_MENU_ID || (out.menus && out.menus[0] && out.menus[0].id);
      if (menuId) {
        const m = await iiko.getExternalMenu(menuId);
        out.external_menu_ok = true;
        out.external_menu_categories = (m.itemCategories||[]).length;
        out.external_menu_items = (m.itemCategories||[]).reduce((s,c)=>s+(c.items||[]).length, 0);
      }
    } catch(e) { out.external_menu_ok = false; out.external_menu_error = (e.message||'').slice(0,300); }
  }
  res.json(out);
});

// Mijoz profili: balans, karta, oxirgi tranzaksiyalar
app.get('/api/customer/me', (req, res) => {
  const tid = getTid(req);
  if (!tid) return res.status(401).json({ error: 'No telegram_id' });
  const customer = getCustomer(tid);
  if (!customer) return res.json({ registered: false });
  const tx = db.prepare("SELECT id, amount, kind, reason, order_id, expires_at, created_at FROM bonus_transactions WHERE customer_telegram_id=? ORDER BY created_at DESC LIMIT 30").all(tid);
  // Eng yaqin tugaydigan kredit
  const nextExpire = db.prepare("SELECT MIN(expires_at) as next_expire FROM bonus_transactions WHERE customer_telegram_id=? AND kind='credit' AND remaining>0 AND expires_at>datetime('now')").get(tid);
  res.json({
    registered: true,
    card_number: customer.card_number,
    bonus_balance: customer.bonus_balance,
    total_earned: customer.total_earned,
    total_spent: customer.total_spent,
    phone: customer.phone,
    first_name: customer.first_name,
    transactions: tx,
    next_expire: nextExpire ? nextExpire.next_expire : null,
    config: {
      bonus_percent: BONUS_PERCENT,
      welcome_bonus: WELCOME_BONUS,
      ttl_days: BONUS_TTL_DAYS,
      max_use_percent: MAX_BONUS_USE_PERCENT
    }
  });
});

// QR kod rasm — karta_raqami ni kodlaydi
app.get('/qr/:cardNumber', async (req, res) => {
  const cn = (req.params.cardNumber || '').replace(/\.png$/i, '').replace(/\D/g, '');
  if (!cn || cn.length < 6) return res.status(400).send('invalid');
  try {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buf = await QRCode.toBuffer(cn, { width: 400, margin: 2, errorCorrectionLevel: 'M' });
    res.send(buf);
  } catch(e) {
    res.status(500).send('error');
  }
});

// Admin ko'rinish: barcha mijozlar bazasi
app.get('/api/admin/customers', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const customers = db.prepare("SELECT * FROM customers ORDER BY created_at DESC LIMIT 500").all();
  res.json(customers);
});

app.get('/api/orders/my', (req, res) => {
  const tid = getTid(req);
  if (!tid) return res.json([]);
  const orders = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(tid);
  orders.forEach(o => { o.items = JSON.parse(o.items); });
  res.json(orders);
});

app.get('/api/admin/groups', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare('SELECT * FROM chats ORDER BY added_at DESC').all());
});

// Ochiq endpoint — guruh kashf qilish uchun (sensitive emas, faqat saqlangan guruhlar)
app.get('/api/groups-discovered', (req, res) => {
  res.json(db.prepare('SELECT id, title, type, username FROM chats ORDER BY added_at DESC').all());
});

// Username orqali chat-ni resolve qilish va saqlash
// Bot username @ kerakmas, lekin guruhda admin bo'lishi shart
app.get('/api/resolve-chat', async (req, res) => {
  const u = (req.query.username || '').replace(/^@/, '');
  if (!u) return res.status(400).json({ error: 'username required' });
  try {
    const chat = await bot.telegram.getChat('@'+u);
    rememberChat(chat);
    res.json({ id: chat.id, title: chat.title, type: chat.type, username: chat.username });
  } catch(e) {
    res.status(500).json({ error: e.description || e.message });
  }
});

app.get('/api/admin/stats', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='new'").get().c,
    accepted: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='accepted'").get().c,
    cooking: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='cooking'").get().c,
    on_way: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='on_way'").get().c,
    delivered: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='delivered'").get().c,
    today_total: db.prepare("SELECT COALESCE(SUM(total),0) as s FROM orders WHERE date(created_at)=date('now') AND status='delivered'").get().s,
    pending_payment: db.prepare("SELECT COUNT(*) as c FROM orders WHERE payment_status='checking'").get().c,
  });
});

app.get('/api/admin/orders', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const s = req.query.status;
  const orders = (s && s!=='all')
    ? db.prepare('SELECT * FROM orders WHERE status=? ORDER BY created_at DESC').all(s)
    : db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  orders.forEach(o => { o.items = JSON.parse(o.items); });
  res.json(orders);
});

app.put('/api/admin/orders/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { status, courier_id, courier_name, payment_status } = req.body;
  if (payment_status) {
    db.prepare('UPDATE orders SET payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(payment_status, req.params.id);
  }
  if (status) {
    db.prepare('UPDATE orders SET status=?,courier_id=?,courier_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(status, courier_id||null, courier_name||null, req.params.id);
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    notifyCustomer(order);
    if (courier_id && status==='on_way') notifyCourier(courier_id, order);
  }
  res.json({ ok: true });
});

app.get('/api/admin/couriers', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare("SELECT * FROM users WHERE role='courier'").all());
});

// Kategoriya boshqaruvi
app.get('/api/admin/categories', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare('SELECT id, name_uz, name_ru, emoji, sort_order, active, iiko_group_id FROM categories ORDER BY sort_order, id').all());
});

app.post('/api/admin/categories', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { name_uz, name_ru, emoji, sort_order, iiko_group_id } = req.body || {};
  if (!name_uz) return res.status(400).json({ error: 'name_uz required' });
  // Mavjudligini tekshirish (iiko_group_id orqali)
  if (iiko_group_id) {
    const existing = db.prepare('SELECT id FROM categories WHERE iiko_group_id=?').get(iiko_group_id);
    if (existing) return res.json({ ok: true, id: existing.id, existed: true });
  }
  const maxOrder = (db.prepare('SELECT MAX(sort_order) as m FROM categories').get().m || 0) + 1;
  const r = db.prepare('INSERT INTO categories (name_uz, name_ru, emoji, sort_order, active, iiko_group_id) VALUES (?, ?, ?, ?, 1, ?)')
    .run(name_uz, name_ru || name_uz, emoji || '🍽', sort_order || maxOrder, iiko_group_id || null);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/admin/categories/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { name_uz, name_ru, emoji, sort_order, active } = req.body || {};
  const sets = [], vals = [];
  if (name_uz !== undefined) { sets.push('name_uz=?'); vals.push(name_uz); }
  if (name_ru !== undefined) { sets.push('name_ru=?'); vals.push(name_ru); }
  if (emoji !== undefined) { sets.push('emoji=?'); vals.push(emoji); }
  if (sort_order !== undefined) { sets.push('sort_order=?'); vals.push(sort_order); }
  if (active !== undefined) { sets.push('active=?'); vals.push(active); }
  if (!sets.length) return res.status(400).json({ error: 'no fields' });
  vals.push(req.params.id);
  db.prepare('UPDATE categories SET '+sets.join(',')+' WHERE id=?').run(...vals);
  res.json({ ok: true });
});

app.get('/api/admin/products', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare('SELECT p.*,c.name_uz as cat_name FROM products p JOIN categories c ON p.category_id=c.id ORDER BY c.sort_order,p.id').all());
});

app.post('/api/admin/products', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { name_uz, name_ru, desc_uz, desc_ru, price, category_id, image, iiko_id, iiko_group_id } = req.body;
  // Agar iiko_id bo'lsa, mavjudligini tekshirib upsert qilamiz
  if (iiko_id) {
    const existing = db.prepare('SELECT id FROM products WHERE iiko_id=?').get(iiko_id);
    if (existing) {
      db.prepare('UPDATE products SET name_uz=?,name_ru=?,desc_uz=?,desc_ru=?,price=?,category_id=?,image=COALESCE(NULLIF(?, ""), image),iiko_group_id=?,active=1 WHERE id=?')
        .run(name_uz, name_ru||'', desc_uz||'', desc_ru||'', price, category_id||1, image||'', iiko_group_id||null, existing.id);
      return res.json({ ok: true, id: existing.id, updated: true });
    }
  }
  const r = db.prepare('INSERT INTO products (category_id,name_uz,name_ru,desc_uz,desc_ru,price,image,iiko_id,iiko_group_id,active) VALUES (?,?,?,?,?,?,?,?,?,1)')
    .run(category_id||1, name_uz, name_ru||'', desc_uz||'', desc_ru||'', price, image||'', iiko_id||null, iiko_group_id||null);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/admin/products/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { name_uz, name_ru, desc_uz, desc_ru, price, category_id, image, iiko_id, iiko_group_id, active } = req.body;
  if (name_uz !== undefined) {
    db.prepare('UPDATE products SET name_uz=?,name_ru=?,desc_uz=?,desc_ru=?,price=?,category_id=?,image=?,iiko_id=COALESCE(?,iiko_id),iiko_group_id=COALESCE(?,iiko_group_id),active=? WHERE id=?')
      .run(name_uz, name_ru||'', desc_uz||'', desc_ru||'', price, category_id||1, image||'', iiko_id||null, iiko_group_id||null, active!==undefined?active:1, req.params.id);
  } else if (iiko_id !== undefined) {
    db.prepare('UPDATE products SET iiko_id=? WHERE id=?').run(iiko_id, req.params.id);
  } else {
    db.prepare('UPDATE products SET active=? WHERE id=?').run(active, req.params.id);
  }
  res.json({ ok: true });
});

app.get('/api/courier/orders', (req, res) => {
  const tid = getTid(req);
  const orders = db.prepare("SELECT * FROM orders WHERE courier_id=? AND status IN ('on_way','accepted') ORDER BY created_at DESC").all(tid);
  orders.forEach(o => { o.items = JSON.parse(o.items); });
  res.json(orders);
});

app.put('/api/courier/orders/:id', (req, res) => {
  const tid = getTid(req);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order || order.courier_id !== tid) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.status, req.params.id);
  notifyCustomer(db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id));
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('Server: ' + PORT));
bot.launch();

// iiko menyusini avtomatik sinxronlash (ishga tushganda + har 4 soatda)
if (iiko.isConfigured()) {
  const runSync = () => syncIikoMenu()
    .then(r => console.log('[iiko] menu sync:', JSON.stringify(r)))
    .catch(e => console.warn('[iiko] menu sync error:', e.message));
  setTimeout(runSync, 10*1000); // ishga tushgandan 10s keyin
  setInterval(runSync, 4*60*60*1000);
} else {
  console.log('[iiko] not configured (set IIKO_API_LOGIN, IIKO_ORGANIZATION_ID)');
}
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
