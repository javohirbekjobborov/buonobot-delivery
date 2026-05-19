require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const path = require('path');
const db = require('./db');

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
  const tid = getTid(req);
  if (!tid) return false;
  const u = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid);
  return u && u.role === 'admin';
}

// ── BOT ──────────────────────────────────────────────────────────────────────

bot.start(async ctx => {
  const id = String(ctx.from.id);
  db.prepare('INSERT OR IGNORE INTO users (telegram_id,first_name,last_name,username) VALUES (?,?,?,?)').run(id, ctx.from.first_name, ctx.from.last_name||'', ctx.from.username||'');

  // Eski persistent reply keyboardni tozalash
  await ctx.reply('Salom, '+ctx.from.first_name+'! 👋', Markup.removeKeyboard()).catch(()=>{});

  if (ADMIN_IDS.includes(id)) {
    db.prepare("UPDATE users SET role='admin' WHERE telegram_id=?").run(id);
    return ctx.reply('Admin panelga xush kelibsiz!', Markup.inlineKeyboard([
      [Markup.button.webApp('📊 Admin Panel', APP_URL+'/admin.html?uid='+id)]
    ]));
  }
  if (COURIER_IDS.includes(id)) {
    db.prepare("UPDATE users SET role='courier' WHERE telegram_id=?").run(id);
    return ctx.reply('Kuryer paneliga xush kelibsiz!', Markup.inlineKeyboard([
      [Markup.button.webApp('🛵 Buyurtmalarim', APP_URL+'/courier.html?uid='+id)]
    ]));
  }
  return ctx.reply(
    '🍔 Buono Burger ga xush kelibsiz!\nBurger, lavash, hot-dog va boshqalarni tez yetkazib beramiz.\n\n⏰ Ish vaqti: 10:00–23:00',
    Markup.inlineKeyboard([
      [Markup.button.webApp('🛒 Menyuni ochish', APP_URL+'/index.html')],
      [Markup.button.callback('⭐ Baho berish', 'fb_main')]
    ])
  );
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
  const state = getFb(uid);
  if (!state || !state.awaitingText) return;
  await finalizeFeedback(ctx, state, ctx.message.text, '');
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
  if (order.status==='on_way' || order.status==='delivered') {
    msg += "\n\n💳 To'lov: "+paymentLabel(order);
  }
  bot.telegram.sendMessage(order.user_id, msg).catch(()=>{});

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

  const allowed = ['cash', 'click', 'payme'];
  if (!allowed.includes(payment)) return res.status(400).json({ error: 'Invalid payment method' });

  const r = db.prepare('INSERT INTO orders (user_id,user_name,user_phone,items,total,address,lat,lng,comment,payment) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(user_id, user_name, user_phone, JSON.stringify(items), total, address, lat, lng, comment, payment);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);

  notifyAdmin(order);

  res.json({ ok: true, order_id: r.lastInsertRowid });
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

app.get('/api/admin/products', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare('SELECT p.*,c.name_uz as cat_name FROM products p JOIN categories c ON p.category_id=c.id ORDER BY c.sort_order,p.id').all());
});

app.post('/api/admin/products', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { name_uz, name_ru, desc_uz, desc_ru, price, category_id, image } = req.body;
  const r = db.prepare('INSERT INTO products (category_id,name_uz,name_ru,desc_uz,desc_ru,price,image,active) VALUES (?,?,?,?,?,?,?,1)')
    .run(category_id||1, name_uz, name_ru||'', desc_uz||'', desc_ru||'', price, image||'');
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/admin/products/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { name_uz, name_ru, desc_uz, desc_ru, price, category_id, image, active } = req.body;
  if (name_uz !== undefined) {
    db.prepare('UPDATE products SET name_uz=?,name_ru=?,desc_uz=?,desc_ru=?,price=?,category_id=?,image=?,active=? WHERE id=?')
      .run(name_uz, name_ru||'', desc_uz||'', desc_ru||'', price, category_id||1, image||'', active!==undefined?active:1, req.params.id);
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
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
