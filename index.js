require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;

const MENU = {
  burgers: [
    { name: 'Classic Burger', price: 25000 },
    { name: 'Double Burger', price: 35000 },
    { name: 'Cheese Burger', price: 30000 },
  ],
  pizza: [
    { name: 'Margherita', price: 45000 },
    { name: 'Pepperoni', price: 55000 },
    { name: 'BBQ Chicken', price: 60000 },
  ],
  drinks: [
    { name: 'Cola', price: 8000 },
    { name: 'Juice', price: 10000 },
    { name: 'Coffee', price: 12000 },
  ]
};

const userOrders = {};

const mainKeyboard = Markup.keyboard([
  ['Menyu', 'Savat'],
  ['Manzil', 'Boglanish'],
  ['Haqimizda']
]).resize();

bot.start((ctx) => {
  ctx.reply('Salom, ' + ctx.from.first_name + '! Buonobot Delivery ga xush kelibsiz!\nTez va sifatli ovqat yetkazib beramiz.\nIsh vaqti: 09:00 - 23:00', mainKeyboard);
});

bot.hears('Menyu', (ctx) => {
  ctx.reply('Kategoriyani tanlang:', Markup.inlineKeyboard([
    [Markup.button.callback('Burgerlar', 'cat_burgers')],
    [Markup.button.callback('Pizzalar', 'cat_pizza')],
    [Markup.button.callback('Ichimliklar', 'cat_drinks')],
  ]));
});

bot.action(/cat_(.+)/, (ctx) => {
  const cat = ctx.match[1];
  const items = MENU[cat];
  if (!items) return ctx.answerCbQuery();
  const buttons = items.map((item, i) =>
    [Markup.button.callback(item.name + ' - ' + item.price.toLocaleString() + ' som', 'add_' + cat + '_' + i)]
  );
  buttons.push([Markup.button.callback('Orqaga', 'back_menu')]);
  ctx.editMessageText('Mahsulot tanlang:', Markup.inlineKeyboard(buttons));
  ctx.answerCbQuery();
});

bot.action('back_menu', (ctx) => {
  ctx.editMessageText('Kategoriyani tanlang:', Markup.inlineKeyboard([
    [Markup.button.callback('Burgerlar', 'cat_burgers')],
    [Markup.button.callback('Pizzalar', 'cat_pizza')],
    [Markup.button.callback('Ichimliklar', 'cat_drinks')],
  ]));
  ctx.answerCbQuery();
});

bot.action(/add_(.+)_(.+)/, (ctx) => {
  const cat = ctx.match[1];
  const idx = parseInt(ctx.match[2]);
  const item = MENU[cat][idx];
  const chatId = ctx.chat.id;
  if (!userOrders[chatId]) userOrders[chatId] = { items: [], total: 0 };
  userOrders[chatId].items.push(item);
  userOrders[chatId].total += item.price;
  ctx.answerCbQuery(item.name + ' savatga qoshildi!');
});

bot.hears('Savat', (ctx) => {
  const chatId = ctx.chat.id;
  const order = userOrders[chatId];
  if (!order || order.items.length === 0) return ctx.reply('Savat bosh. Menyu dan buyurtma bering!');
  let text = 'Buyurtmangiz:\n\n';
  order.items.forEach((item, i) => { text += (i + 1) + '. ' + item.name + ' - ' + item.price.toLocaleString() + ' som\n'; });
  text += '\nJami: ' + order.total.toLocaleString() + ' som';
  ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback('Tasdiqlash', 'confirm_order')],
    [Markup.button.callback('Savatni tozalash', 'clear_cart')]
  ]));
});

bot.action('clear_cart', (ctx) => {
  userOrders[ctx.chat.id] = { items: [], total: 0 };
  ctx.editMessageText('Savat tozalandi!');
  ctx.answerCbQuery();
});

bot.action('confirm_order', (ctx) => {
  const order = userOrders[ctx.chat.id];
  if (!order || order.items.length === 0) return ctx.answerCbQuery('Savat bosh!', { show_alert: true });
  ctx.reply('Manzilingizni yuboring:', Markup.keyboard([[Markup.button.locationRequest('Lokatsiyamni yuborish')]]).oneTime().resize());
  ctx.answerCbQuery();
});

bot.on('location', (ctx) => {
  const chatId = ctx.chat.id;
  const order = userOrders[chatId];
  if (!order || order.items.length === 0) return ctx.reply('Buyurtma topilmadi.');
  const adminId = process.env.ADMIN_CHAT_ID;
  let msg = 'YANGI BUYURTMA!\nMijoz: ' + ctx.from.first_name + '\n@' + (ctx.from.username || 'yoq') + '\n\n';
  order.items.forEach((item, i) => { msg += (i + 1) + '. ' + item.name + ' - ' + item.price.toLocaleString() + ' som\n'; });
  msg += '\nJami: ' + order.total.toLocaleString() + ' som';
  if (adminId) { bot.telegram.sendMessage(adminId, msg); bot.telegram.sendLocation(adminId, ctx.message.location.latitude, ctx.message.location.longitude); }
  ctx.reply('Buyurtma qabul qilindi! 30-45 daqiqa. Jami: ' + order.total.toLocaleString() + ' som. Rahmat!', mainKeyboard);
  userOrders[chatId] = { items: [], total: 0 };
});

bot.hears('Manzil', (ctx) => ctx.reply('Toshkent, Chilonzor tumani.'));
bot.hears('Boglanish', (ctx) => ctx.reply('Tel: +998 90 123 45 67\nIsh vaqti: 09:00 - 23:00'));
bot.hears('Haqimizda', (ctx) => ctx.reply('Buonobot Delivery\nBurger, pizza, ichimliklar\n30-45 daqiqada yetkazib berish'));

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.listen(PORT, () => console.log('Server: ' + PORT));

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
