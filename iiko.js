// iiko Cloud API client
// Hujjat: https://api-ru.iiko.services/api/1/help
const BASE = 'https://api-ru.iiko.services';

const API_LOGIN = process.env.IIKO_API_LOGIN || '';
const ORG_ID = process.env.IIKO_ORGANIZATION_ID || '';
const TERMINAL_GROUP_ID = process.env.IIKO_TERMINAL_GROUP_ID || '';
const CRM_ENABLED = (process.env.IIKO_CRM_ENABLED || 'false').toLowerCase() === 'true';

let tokenCache = { token: null, exp: 0 };

function isConfigured() { return !!(API_LOGIN && ORG_ID); }

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const res = await fetch(BASE + '/api/1/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
      'Authorization': 'Bearer ' + token
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
      phone: payload.phone || '',
      customer: payload.customerName ? { name: payload.customerName, type: 'regular' } : undefined,
      items,
      comment: payload.comment || '',
      orderTypeId: payload.orderTypeId,
      orderServiceType: payload.deliveryType === 'pickup' ? 'DeliveryPickUp' : 'DeliveryByCourier'
    }
  };
  if (payload.address && payload.deliveryType !== 'pickup') {
    body.order.deliveryPoint = {
      address: { street: { name: payload.address }, house: payload.house || '-', city: 'Tashkent' }
    };
  }
  return call('/api/1/deliveries/create', body);
}

// CRM bo'lganda — mijoz sinxronizatsiyasi
async function customerCreateOrUpdate(customer) {
  if (!isConfigured() || !CRM_ENABLED) return null;
  return call('/api/1/loyalty/iiko/customer/create_or_update', {
    organizationId: ORG_ID,
    phone: customer.phone,
    name: customer.first_name || '',
    middleName: '',
    surName: customer.last_name || '',
    cardNumbers: customer.card_number ? [{ number: String(customer.card_number) }] : []
  });
}

async function customerInfo(phone) {
  if (!isConfigured() || !CRM_ENABLED) return null;
  return call('/api/1/loyalty/iiko/customer/info', {
    organizationId: ORG_ID,
    type: 'phone',
    phone
  });
}

async function customerRefillWallet(customerId, walletId, sum, comment) {
  if (!isConfigured() || !CRM_ENABLED) return null;
  return call('/api/1/loyalty/iiko/customer/wallet/refill', {
    organizationId: ORG_ID,
    customerId,
    walletId,
    sum,
    comment: comment || 'Auto cashback'
  });
}

module.exports = {
  isConfigured,
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
  customerInfo,
  customerRefillWallet
};
