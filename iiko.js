// iiko Cloud API client
// Hujjat: https://api-ru.iiko.services/api/1/help
const BASE = 'https://api-ru.iiko.services';

const API_LOGIN = process.env.IIKO_API_LOGIN || '';
const ORG_ID = process.env.IIKO_ORGANIZATION_ID || '';
const TERMINAL_GROUP_ID = process.env.IIKO_TERMINAL_GROUP_ID || '';
const CRM_ENABLED = (process.env.IIKO_CRM_ENABLED || 'false').toLowerCase() === 'true';

let tokenCache = { token: null, exp: 0 };

function isConfigured() { return !!(API_LOGIN && ORG_ID); }

// Telefonni iiko uchun xalqaro formatga keltiramiz (+998XXXXXXXXX).
// iiko "+" bilan boshlanmagan raqamni rad etadi: "Phone number must begin with symbol +".
function normalizePhone(raw) {
  if (raw === undefined || raw === null) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 9) {
    // Lokal UZ raqami: 901234567 -> 998901234567
    digits = '998' + digits;
  } else if (digits.length === 12 && digits.startsWith('998')) {
    // 998901234567 -> shundayligicha
  }
  // Boshqa uzunliklar bor holicha qoladi, faqat "+" kafolatlanadi
  return '+' + digits;
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const res = await fetch(BASE + '/api/1/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'BuonoBotDelivery/1.0 (Node.js)'
    },
    body: JSON.stringify({ apiLogin: API_LOGIN })
  });
  if (!res.ok) throw new Error('iiko token http ' + res.status);
  const data = await res.json();
  if (!data.token) throw new Error('iiko token missing');
  // Tokens are valid for ~1h; refresh every 50 min
  tokenCache = { token: data.token, exp: Date.now() + 50 * 60 * 1000 };
  return data.token;
}

async function call(path, body, retry = true) {
  const token = await getToken();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
      'User-Agent': 'BuonoBotDelivery/1.0 (Node.js; +https://buonobot-delivery-production.up.railway.app)'
    },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch(e) { data = { _raw: text }; }
  if (!res.ok) {
    // 401 → token eskirgan, qayta urinamiz
    if (res.status === 401 && retry) {
      tokenCache.token = null;
      return call(path, body, false);
    }
    const err = new Error('iiko ' + path + ' http ' + res.status + ': ' + (data.message || data.errorCode || text.slice(0, 200)));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function getNomenclature() {
  return call('/api/1/nomenclature', { organizationId: ORG_ID });
}

// External Menu (Внешнее меню) — yetkazib berish uchun
async function listExternalMenus() {
  return call('/api/2/menu', { organizationIds: [ORG_ID] });
}

async function getExternalMenu(externalMenuId) {
  return call('/api/2/menu/by_id', { externalMenuId: String(externalMenuId), organizationIds: [ORG_ID] });
}

async function getTerminalGroups() {
  return call('/api/1/terminal_groups', { organizationIds: [ORG_ID] });
}

async function getPaymentTypes() {
  return call('/api/1/payment_types', { organizationIds: [ORG_ID] });
}

// Buyurtmani iiko-ga yuborish
// Hujjat: /api/1/deliveries/create
// payload: {phone, name, items:[{iikoProductId, amount}], address, comment, deliveryDate}
async function createDelivery(payload) {
  if (!isConfigured()) throw new Error('iiko not configured');
  if (!TERMINAL_GROUP_ID) throw new Error('IIKO_TERMINAL_GROUP_ID missing');

  const items = (payload.items || []).filter(i => i.iikoProductId && i.amount > 0).map(i => ({
    productId: i.iikoProductId,
    amount: i.amount,
    type: 'Product',
    comment: i.comment || ''
  }));
  if (!items.length) throw new Error('No iiko items to send');

  const body = {
    organizationId: ORG_ID,
    terminalGroupId: TERMINAL_GROUP_ID,
    createOrderSettings: { mode: 'Async' },
    order: {
      phone: normalizePhone(payload.phone),
      customer: payload.customerName ? { name: payload.customerName, type: 'regular' } : undefined,
      items,
      comment: payload.comment || '',
      orderTypeId: payload.orderTypeId,
      orderServiceType: payload.deliveryType === 'pickup' ? 'DeliveryPickUp' : 'DeliveryByCourier'
    }
  };
  // Yetkazib berish uchun manzil nuqtasi: matn + (agar bor bo'lsa) GPS koordinatalari.
  // Manzil matni bo'sh bo'lsa ham koordinata bilan yuboramiz (GPS-only buyurtmalar).
  if (payload.deliveryType !== 'pickup') {
    const streetName = (payload.address && String(payload.address).trim()) || 'GPS lokatsiya';
    const dp = {
      address: { street: { name: streetName }, house: payload.house || '-', city: 'Tashkent' }
    };
    if (typeof payload.lat === 'number' && typeof payload.lng === 'number') {
      dp.coordinates = { latitude: payload.lat, longitude: payload.lng };
    }
    body.order.deliveryPoint = dp;
  }
  return call('/api/1/deliveries/create', body);
}

// CRM — mijoz yaratish / yangilash. customer/create_or_update karta qabul qilmaydi,
// kartani alohida customer/card/add orqali qo'shamiz.
async function customerCreateOrUpdate(customer) {
  if (!isConfigured() || !CRM_ENABLED) return null;
  const body = {
    organizationId: ORG_ID,
    phone: normalizePhone(customer.phone),
    name: customer.first_name || customer.name || '',
    middleName: '',
    surName: customer.last_name || ''
  };
  // Jins → sex (1 = Male, 2 = Female; iiko enum)
  if (customer.gender === 'male') body.sex = 1;
  else if (customer.gender === 'female') body.sex = 2;
  // Yosh oralig'idan taxminiy tug'ilgan yil (median yoshda, 1-yanvar)
  if (customer.age_range) {
    const medians = { '18-25': 21, '25-35': 30, '35-45': 40, '50+': 55 };
    const median = medians[customer.age_range];
    if (median) {
      const year = new Date().getFullYear() - median;
      body.birthday = year + '-01-01T00:00:00';
    }
  }
  return call('/api/1/loyalty/iiko/customer/create_or_update', body);
}

async function customerCardAdd(customerId, cardNumber) {
  if (!isConfigured() || !CRM_ENABLED) return null;
  return call('/api/1/loyalty/iiko/customer/card/add', {
    organizationId: ORG_ID,
    customerId,
    cardTrack: String(cardNumber),
    cardNumber: String(cardNumber)
  });
}

async function customerInfo(phone) {
  if (!isConfigured() || !CRM_ENABLED) return null;
  return call('/api/1/loyalty/iiko/customer/info', {
    organizationId: ORG_ID,
    type: 'phone',
    phone: normalizePhone(phone)
  });
}

// Wallet refill (topup) — bonus qo'shish
async function customerWalletTopup(customerId, walletId, sum, comment) {
  if (!isConfigured() || !CRM_ENABLED) return null;
  return call('/api/1/loyalty/iiko/customer/wallet/topup', {
    organizationId: ORG_ID,
    customerId,
    walletId,
    sum,
    comment: comment || 'Auto cashback'
  });
}

// Wallet chargeoff (withdraw) — bonus olib qo'yish
async function customerWalletChargeoff(customerId, walletId, sum, comment) {
  if (!isConfigured() || !CRM_ENABLED) return null;
  return call('/api/1/loyalty/iiko/customer/wallet/chargeoff', {
    organizationId: ORG_ID,
    customerId,
    walletId,
    sum,
    comment: comment || 'Bonus spent'
  });
}

// Loyalty dasturlari (wallet ID-larini topish uchun)
async function getLoyaltyPrograms() {
  if (!isConfigured() || !CRM_ENABLED) return null;
  return call('/api/1/loyalty/iiko/program', { organizationId: ORG_ID });
}

module.exports = {
  isConfigured,
  normalizePhone,
  crmEnabled: () => CRM_ENABLED,
  config: { ORG_ID, TERMINAL_GROUP_ID },
  getToken,
  getNomenclature,
  listExternalMenus,
  getExternalMenu,
  getTerminalGroups,
  getPaymentTypes,
  createDelivery,
  customerCreateOrUpdate,
  customerCardAdd,
  customerInfo,
  customerWalletTopup,
  customerWalletChargeoff,
  getLoyaltyPrograms
};
