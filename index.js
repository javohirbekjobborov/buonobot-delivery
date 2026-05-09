require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const app = express();
const PORT = process.env.PORT || 3000;
const MENU = {
  burgers: [{ name: '🍔 Classic Burger', price: 25000 }, { name: '🍔 Double Burger', price: 35000 }, { name: '🍔 Cheese Burger', price: 30000 }],
  pizza: [{ name: '🍕 Margherita', price: 45000 }, { name: '🍕 Pepperoni', price: 55000 }, { name: '🍕 BBQ Chicken', price: 60000 }],
  drinks: [{ name: '🥤 Cola', price: 8000 }, { name: '🥤 Juice', price: 10000 }, { name: '☕ Coffee', price: 12000 }]
};
const userOrders = {};
const mainKeyboard = { reply_markup: { keyboard: [['🍽 Menyu', '🛒 Savat'], ['📍 Manzil', '📞 Boglanish'], ['ℹ️ Haqimizda']], resize_keyboard: true } };
bot.onText(/\/start/, (msg) => { bot.sendMessage(msg.chat.id, 'Salom, ' + msg.from.first_name + '! 👋\nBuonobot Delivery ga xush kelibsiz! 🍔🍕\nTez va sifatli ovqat yetkazib beramiz.', mainKeyboard); });
bot.onText(/🍽 Menyu/, (msg) => { bot.sendMessage(msg.chat.id, 'Kategoriyani tanlang:', { reply_markup: { inline_keyboard: [[{ text: '🍔 Burgerlar', callback_data: 'cat_burgers' }], [{ text: '🍕 Pizzalar', callback_data: 'cat_pizza' }], [{ text: '🥤 Ichimliklar', callback_data: 'cat_drinks' }]] } }); });
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  if (data.startsWith('cat_')) {
    const cat = data.replace('cat_', '');
    const items = MENU[cat];
    if (!items) return;
    const keyboard = items.map((item, i) => ([{ text: item.name + ' - ' + item.price.toLocaleString() + ' som', callback_data: 'add_' + cat + '_' + i }]));
    keyboard.push([{ text: '⬅️ Orqaga', callback_data: 'back_menu' }]);
    bot.editMessageText(cat + ' menyusi:', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
  }
  if (data === 'back_menu') { bot.editMessageText('Kategoriyani tanlang:', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: '🍔 Burgerlar', callback_data: 'cat_burgers' }], [{ text: '🍕 Pizzalar', callback_data: 'cat_pizza' }], [{ text: '🥤 Ichimliklar', callback_data: 'cat_drinks' }]] } }); }
  if (data.startsWith('add_')) {
    const parts = data.split('_'); const cat = parts[1]; const idx = parseInt(parts[2]); const item = MENU[cat][idx];
    if (!userOrders[chatId]) userOrders[chatId] = { items: [], total: 0 };
    userOrders[chatId].items.push(item); userOrders[chatId].total += item.price;
    bot.answerCallbackQuery(query.id, { text: '✅ ' + item.name + ' savatga qoshildi!', show_alert: false });
  }
  if (data === 'clear_cart') { userOrders[chatId] = { items: [], total: 0 }; bot.editMessageText('🗑 Savat tozalandi!', { chat_id: chatId, message_id: query.message.message_id }); }
  if (data === 'confirm_order') {
    const order = userOrders[chatId];
    if (!order || order.items.length === 0) { bot.answerCallbackQuery(query.id, { text: '❌ Savat bosh!', show_alert: true }); return; }
    bot.sendMessage(chatId, '📍 Manzilingizni yuboring:', { reply_markup: { keyboard: [[{ text: '📍 Lokatsiyamni yuborish', request_location: true }]], resize_keyboard: true, one_time_keyboard: true } });
  }
});
bot.onText(/🛒 Savat/, (msg) => {
  const chatId = msg.chat.id; const order = userOrders[chatId];
  if (!order || order.items.length === 0) { bot.sendMessage(chatId, '🛒 Savat bosh. Menyu dan buyurtma bering!'); return; }
  let text = '🛒 *Buyurtmangiz:*\n\n';
  order.items.forEach((item, i) => { text += (i+1) + '. ' + item.name + ' — ' + item.price.toLocaleString() + ' som\n'; });
  text += '\n💰 *Jami: ' + order.total.toLocaleString() + ' som*';
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 'confirm_order' }], [{ text: '🗑 Tozalash', callback_data: 'clear_cart' }]] } });
});
bot.on('location', (msg) => {
  const chatId = msg.chat.id; const order = userOrders[chatId];
  if (!order || order.items.length === 0) { bot.sendMessage(chatId, '❌ Buyurtma topilmadi.'); return; }
  const adminId = process.env.ADMIN_CHAT_ID;
  let adminMsg = '🆕 *YANGI BUYURTMA!*\n\n👤 ' + msg.from.first_name + '\n📱 @' + (msg.from.username||'yoq') + '\n\n🛒 *Buyurtma:*\n';
  order.items.forEach((item, i) => { adminMsg += (i+1) + '. ' + item.name + ' — ' + item.price.toLocaleString() + ' som\n'; });
  adminMsg += '\n💰 *Jami: ' + order.total.toLocaleString() + ' som*';
  if (adminId) { bot.sendMessage(adminId, adminMsg, { parse_mode: 'Markdown' }); bot.sendLocation(adminId, msg.location.latitude, msg.location.longitude); }
  bot.sendMessage(chatId, '✅ *Buyurtma qabul qilindi!*\n\n⏱ 30-45 daqiqa\n💰 ' + order.total.toLocaleString() + ' som\n\nRahmat! 🙏', { parse_mode: 'Markdown', ...mainKeyboard });
  userOrders[chatId] = { items: [], total: 0 };
});
bot.onText(/📍 Manzil/, (msg) => { bot.sendMessage(msg.chat.id, '📍 Toshkent, Chilonzor tumani\nYetkazib berish: Toshkent boylab'); });
bot.onText(/📞 Boglanish/, (msg) => { bot.sendMessage(msg.chat.id, '📞 +998 90 123 45 67\n⏰ 09:00 - 23:00'); });
bot.onText(/ℹ️ Haqimizda/, (msg) => { bot.sendMessage(msg.chat.id, 'ℹ️ Buonobot Delivery\n🍔 Burger, pizza, ichimliklar\n🚀 30-45 daqiqada yetkazib berish'); });
app.get('/', (req, res) => { res.sendFile(__dirname + '/public/index.html'); });
app.listen(PORT, () => { console.log('Server port ' + PORT); });
