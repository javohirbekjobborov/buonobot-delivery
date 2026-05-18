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

app.use(express.json());
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

bot.start(ctx => {
  const id = String(ctx.from.id);
  db.prepare('INSERT OR IGNORE INTO users (telegram_id,first_name,last_name,username) VALUES (?,?,?,?)').run(id, ctx.from.first_name, ctx.from.last_name||'', ctx.from.username||'');
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
  ctx.reply('Salom, '+ctx.from.first_name+'! 👋\n\n🍔 Buono Burger ga xush kelibsiz!\nBurger va pizzalarni tez yetkazib beramiz.\n\n⏰ Ish vaqti: 10:00–23:00', Markup.inlineKeyboard([
    [Markup.button.webApp('🛒 Buyurtma berish', APP_URL+'/index.html')]
  ]));
});

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

  ADMIN_IDS.forEach(id => {
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
