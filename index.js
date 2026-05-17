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

const RESTAURANT_LAT = parseFloat(process.env.RESTAURANT_LAT || '41.3588914');
const RESTAURANT_LNG = parseFloat(process.env.RESTAURANT_LNG || '69.3366373');
const RESTAURANT_ADDRESS = process.env.RESTAURANT_ADDRESS || "Yunusobod tumani, Gullola ko'chasi 13";
const DELIVERY_RADIUS_KM = parseFloat(process.env.DELIVERY_RADIUS_KM || '7');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

app.use(express.json({limit:'5mb'}));
app.use(express.static(path.join(__dirname, 'public')));

bot.start(async ctx => {
  const id = String(ctx.from.id);
  db.prepare('INSERT OR IGNORE INTO users (telegram_id,first_name,last_name,username) VALUES (?,?,?,?)').run(id, ctx.from.first_name, ctx.from.last_name||'', ctx.from.username||'');

  // Clear any persistent reply keyboard from previous bot versions
  await ctx.reply('Salom, '+ctx.from.first_name+'!', Markup.removeKeyboard()).catch(()=>{});

  if (ADMIN_IDS.includes(id)) {
    db.prepare("UPDATE users SET role='admin' WHERE telegram_id=?").run(id);
    return ctx.reply('Admin panelga xush kelibsiz!', Markup.inlineKeyboard([[Markup.button.webApp('Admin Panel', APP_URL+'/admin.html')]]));
  }
  if (COURIER_IDS.includes(id)) {
    db.prepare("UPDATE users SET role='courier' WHERE telegram_id=?").run(id);
    return ctx.reply('Kuryer paneliga xush kelibsiz!', Markup.inlineKeyboard([[Markup.button.webApp('Mening buyurtmalarim', APP_URL+'/courier.html')]]));
  }
  return ctx.reply(
    'Buono Burger ga xush kelibsiz!\n'+
    'Burger, lavash, hot-dog va boshqalarni tez yetkazib beramiz.\n'+
    'Ish vaqti: 10:00-23:00\n'+
    'Manzil: '+RESTAURANT_ADDRESS+'\n'+
    'Yetkazib berish radiusi: '+DELIVERY_RADIUS_KM+' km',
    Markup.inlineKeyboard([[Markup.button.webApp('Buyurtma berish', APP_URL+'/index.html')]])
  );
});

function notifyAdmin(order) {
  const items = JSON.parse(order.items);
  let t = 'YANGI BUYURTMA #'+order.id+'\n\n';
  t += order.user_name+' | '+(order.user_phone||'-')+'\n';
  items.forEach(i => { t += i.name_uz+' x'+i.qty+' = '+(i.price*i.qty).toLocaleString()+" so'm\n"; });
  t += '\nJami: '+order.total.toLocaleString()+" so'm";
  t += '\n'+(order.delivery_type==='pickup'?"O'zi olib ketadi":'Yetkazib berish');
  t += '\n'+(order.payment==='cash'?'Naqd':order.payment==='click'?'Click':'Payme');
  if (order.comment) t += '\nIzoh: '+order.comment;
  if (order.address) t += '\nManzil: '+order.address;
  ADMIN_IDS.forEach(id => {
    bot.telegram.sendMessage(id, t).catch(()=>{});
    if (order.delivery_type!=='pickup' && order.lat && order.lng) bot.telegram.sendLocation(id, order.lat, order.lng).catch(()=>{});
  });
}

function notifyCourier(courierId, order) {
  const items = JSON.parse(order.items);
  let t = 'Yangi buyurtma #'+order.id+' tayinlandi!\n\n';
  t += order.user_name+'\n'+(order.user_phone||'-')+'\n';
  if (order.address) t += order.address+'\n';
  t += items.map(i=>i.name_uz+' x'+i.qty).join(', ')+'\nJami: '+order.total.toLocaleString()+" so'm";
  bot.telegram.sendMessage(courierId, t).catch(()=>{});
  if (order.lat&&order.lng) bot.telegram.sendLocation(courierId, order.lat, order.lng).catch(()=>{});
}

function notifyCustomer(order) {
  const m={accepted:'Buyurtmangiz qabul qilindi!',cooking:'Tayyorlanmoqda...',on_way:"Kuryer yo'lda!",delivered:'Yetkazildi! Rahmat!'};
  if (m[order.status]) bot.telegram.sendMessage(order.user_id, m[order.status]).catch(()=>{});
}

function getUser(req) {
  const tid = req.headers['x-telegram-id'];
  return tid ? db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid) : null;
}

app.get('/api/config', (req,res) => {
  res.json({
    restaurant_lat: RESTAURANT_LAT,
    restaurant_lng: RESTAURANT_LNG,
    restaurant_address: RESTAURANT_ADDRESS,
    delivery_radius_km: DELIVERY_RADIUS_KM
  });
});

app.get('/api/menu', (req,res) => {
  const cats = db.prepare('SELECT * FROM categories WHERE active=1 ORDER BY sort_order').all();
  const prods = db.prepare('SELECT * FROM products WHERE active=1').all();
  cats.forEach(c => { c.products = prods.filter(p=>p.category_id===c.id); });
  res.json(cats);
});

app.post('/api/user', (req,res) => {
  const {telegram_id,first_name,last_name,username} = req.body;
  db.prepare('INSERT OR IGNORE INTO users (telegram_id,first_name,last_name,username) VALUES (?,?,?,?)').run(telegram_id,first_name,last_name||'',username||'');
  if (ADMIN_IDS.includes(String(telegram_id))) db.prepare("UPDATE users SET role='admin' WHERE telegram_id=?").run(telegram_id);
  else if (COURIER_IDS.includes(String(telegram_id))) db.prepare("UPDATE users SET role='courier' WHERE telegram_id=?").run(telegram_id);
  res.json(db.prepare('SELECT * FROM users WHERE telegram_id=?').get(telegram_id));
});

app.post('/api/orders', (req,res) => {
  const {user_id,user_name,user_phone,items,total,address,lat,lng,comment,payment,delivery_type} = req.body;
  const dt = delivery_type==='pickup' ? 'pickup' : 'delivery';
  if (dt === 'delivery') {
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({error:'Joylashuvni yuboring yoki o\'zi olib ketishni tanlang'});
    }
    const distance = haversineKm(RESTAURANT_LAT, RESTAURANT_LNG, lat, lng);
    if (distance > DELIVERY_RADIUS_KM) {
      return res.status(400).json({error:'Manzilingiz '+distance.toFixed(1)+' km uzoqlikda. Bizning yetkazib berish radiusimiz '+DELIVERY_RADIUS_KM+' km'});
    }
  }
  const finalAddress = dt==='pickup' ? RESTAURANT_ADDRESS : address;
  const finalLat = dt==='pickup' ? RESTAURANT_LAT : lat;
  const finalLng = dt==='pickup' ? RESTAURANT_LNG : lng;
  const r = db.prepare('INSERT INTO orders (user_id,user_name,user_phone,items,total,address,lat,lng,comment,payment,delivery_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(user_id,user_name,user_phone,JSON.stringify(items),total,finalAddress,finalLat,finalLng,comment,payment,dt);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);
  notifyAdmin(order);
  res.json({ok:true, order_id:r.lastInsertRowid});
});

app.get('/api/orders/my', (req,res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(req.headers['x-telegram-id']);
  orders.forEach(o=>{o.items=JSON.parse(o.items);});
  res.json(orders);
});

app.get('/api/admin/orders', (req,res) => {
  const u = getUser(req);
  if (!u||u.role!=='admin') return res.status(403).json({error:'Forbidden'});
  const s = req.query.status;
  const orders = (s&&s!=='all') ? db.prepare('SELECT * FROM orders WHERE status=? ORDER BY created_at DESC').all(s) : db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  orders.forEach(o=>{o.items=JSON.parse(o.items);});
  res.json(orders);
});

app.put('/api/admin/orders/:id', (req,res) => {
  const u = getUser(req);
  if (!u||u.role!=='admin') return res.status(403).json({error:'Forbidden'});
  const {status,courier_id,courier_name} = req.body;
  db.prepare('UPDATE orders SET status=?,courier_id=?,courier_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,courier_id||null,courier_name||null,req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  notifyCustomer(order);
  if (courier_id&&status==='on_way') notifyCourier(courier_id, order);
  res.json({ok:true});
});

app.get('/api/admin/couriers', (req,res) => {
  const u = getUser(req);
  if (!u||u.role!=='admin') return res.status(403).json({error:'Forbidden'});
  res.json(db.prepare("SELECT * FROM users WHERE role='courier'").all());
});

app.get('/api/admin/products', (req,res) => {
  const u = getUser(req);
  if (!u||u.role!=='admin') return res.status(403).json({error:'Forbidden'});
  res.json(db.prepare('SELECT p.*,c.name_uz as cat_name FROM products p JOIN categories c ON p.category_id=c.id ORDER BY c.sort_order,p.id').all());
});

app.post('/api/admin/products', (req,res) => {
  const u = getUser(req);
  if (!u||u.role!=='admin') return res.status(403).json({error:'Forbidden'});
  const {name_uz,name_ru,desc_uz,desc_ru,price,category_id,image,active} = req.body;
  const r = db.prepare('INSERT INTO products (category_id,name_uz,name_ru,desc_uz,desc_ru,price,image,active) VALUES (?,?,?,?,?,?,?,?)').run(category_id||1,name_uz,name_ru,desc_uz||'',desc_ru||'',price,image||'',active!==undefined?active:1);
  res.json({ok:true,id:r.lastInsertRowid});
});

app.put('/api/admin/products/:id', (req,res) => {
  const u = getUser(req);
  if (!u||u.role!=='admin') return res.status(403).json({error:'Forbidden'});
  const {name_uz,name_ru,desc_uz,desc_ru,price,category_id,image,active} = req.body;
  if (name_uz!==undefined) {
    db.prepare('UPDATE products SET name_uz=?,name_ru=?,desc_uz=?,desc_ru=?,price=?,category_id=?,image=?,active=? WHERE id=?').run(name_uz,name_ru||'',desc_uz||'',desc_ru||'',price,category_id||1,image||'',active!==undefined?active:1,req.params.id);
  } else {
    db.prepare('UPDATE products SET active=? WHERE id=?').run(active,req.params.id);
  }
  res.json({ok:true});
});

app.delete('/api/admin/products/:id', (req,res) => {
  const u = getUser(req);
  if (!u||u.role!=='admin') return res.status(403).json({error:'Forbidden'});
  db.prepare('UPDATE products SET active=0 WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

app.get('/api/admin/stats', (req,res) => {
  const u = getUser(req);
  if (!u||u.role!=='admin') return res.status(403).json({error:'Forbidden'});
  res.json({
    new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='new'").get().c,
    accepted: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='accepted'").get().c,
    cooking: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='cooking'").get().c,
    on_way: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='on_way'").get().c,
    delivered: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='delivered'").get().c,
    today_total: db.prepare("SELECT COALESCE(SUM(total),0) as s FROM orders WHERE date(created_at)=date('now') AND status='delivered'").get().s,
    users_count: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='customer'").get().c,
  });
});

app.post('/api/admin/broadcast', async (req,res) => {
  const u = getUser(req);
  if (!u||u.role!=='admin') return res.status(403).json({error:'Forbidden'});
  const {message} = req.body;
  if (!message || !message.trim()) return res.status(400).json({error:"Xabar bo'sh"});
  const users = db.prepare("SELECT telegram_id FROM users WHERE role='customer'").all();
  let sent = 0, failed = 0;
  for (const uu of users) {
    try { await bot.telegram.sendMessage(uu.telegram_id, message); sent++; }
    catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 35));
  }
  res.json({ok:true, sent, failed, total: users.length});
});

app.get('/api/courier/orders', (req,res) => {
  const orders = db.prepare("SELECT * FROM orders WHERE courier_id=? AND status IN ('on_way','accepted') ORDER BY created_at DESC").all(req.headers['x-telegram-id']);
  orders.forEach(o=>{o.items=JSON.parse(o.items);});
  res.json(orders);
});

app.put('/api/courier/orders/:id', (req,res) => {
  const tid = req.headers['x-telegram-id'];
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order||order.courier_id!==tid) return res.status(403).json({error:'Forbidden'});
  db.prepare('UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.status, req.params.id);
  notifyCustomer(db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id));
  res.json({ok:true});
});

app.listen(PORT, ()=>console.log('Server: '+PORT));
bot.launch();
process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
