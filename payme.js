// Payme (Paycom) Merchant API — JSON-RPC 2.0 protokoli
// Hujjat: https://developer.help.paycom.uz/protokol-merchant-api/
// Sandbox: https://test.paycom.uz  (test kalit bilan)
//
// Payme SERVER → BIZNING /payme endpoint ga so'rov yuboradi.
// Biz javob qaytaramiz. Auth: Basic base64("Paycom:" + KEY).

const MERCHANT_ID = process.env.PAYME_MERCHANT_ID || '';
const KEY = process.env.PAYME_KEY || '';            // Production kalit
const TEST_KEY = process.env.PAYME_TEST_KEY || '';   // Sandbox (test) kalit
// Checkout (to'lov sahifasi) manzili. Test uchun ham checkout.paycom.uz ishlaydi.
const CHECKOUT_URL = (process.env.PAYME_CHECKOUT_URL || 'https://checkout.paycom.uz').replace(/\/+$/, '');
// account (hisob) maydonining texnik nomi — merchant kabinetida kiritilgani bilan bir xil bo'lishi shart
const ACCOUNT_FIELD = process.env.PAYME_ACCOUNT_FIELD || 'order_id';

// Transaksiya holatlari (Payme protokoli)
const STATE = {
  CREATED: 1,                  // yaratildi, perform kutilmoqda
  COMPLETED: 2,                // amalga oshirildi (to'landi)
  CANCELLED: -1,               // perform gacha bekor qilindi
  CANCELLED_AFTER_COMPLETE: -2 // perform dan keyin bekor qilindi (refund)
};

// Transaksiya "yashash" muddati — 12 soat (ms). Undan oshgan CREATED tranzaksiya bekor qilinadi.
const TIMEOUT_MS = 12 * 60 * 60 * 1000;

// Xato kodlari (Payme Merchant API)
const ERR = {
  INVALID_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  COULD_NOT_CANCEL: -31007,
  COULD_NOT_PERFORM: -31008,
  INVALID_ACCOUNT: -31050,   // hisob (order) topilmadi / band / noto'g'ri
  METHOD_NOT_FOUND: -32601,
  PARSE_ERROR: -32700,
  INVALID_PARAMS: -32602,
  INSUFFICIENT_PRIVILEGE: -32504
};

function isConfigured() {
  return !!(MERCHANT_ID && (KEY || TEST_KEY));
}

// Ko'p tilli xato xabari (Payme talab qiladi)
function msg(ru, uz, en) {
  return { ru, uz: uz || ru, en: en || ru };
}

// JSON-RPC xato obyekti
function rpcError(code, message, data) {
  const e = { code, message };
  if (data !== undefined) e.data = data;
  return e;
}

// Basic-auth sarlavhasini tekshiradi: base64("Paycom:" + KEY)
// Sandbox test kaliti ham, production kaliti ham qabul qilinadi.
function checkAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  } catch (e) { return false; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const pass = decoded.slice(idx + 1); // "Paycom:<key>" → <key>
  if (KEY && pass === KEY) return true;
  if (TEST_KEY && pass === TEST_KEY) return true;
  return false;
}

// Checkout (to'lov) havolasini yaratadi.
// params: m=<merchant>;ac.<field>=<orderId>;a=<amount_tiyin>;c=<callback>;l=<lang>
function checkoutUrl(orderId, amountTiyin, callbackUrl, lang) {
  const parts = [
    'm=' + MERCHANT_ID,
    'ac.' + ACCOUNT_FIELD + '=' + orderId,
    'a=' + amountTiyin
  ];
  if (callbackUrl) parts.push('c=' + callbackUrl);
  parts.push('l=' + (lang || 'uz'));
  const encoded = Buffer.from(parts.join(';'), 'utf8').toString('base64');
  return CHECKOUT_URL + '/' + encoded;
}

module.exports = {
  MERCHANT_ID,
  ACCOUNT_FIELD,
  STATE,
  TIMEOUT_MS,
  ERR,
  isConfigured,
  msg,
  rpcError,
  checkAuth,
  checkoutUrl,
  config: { merchant_id: MERCHANT_ID, has_key: !!KEY, has_test_key: !!TEST_KEY, checkout_url: CHECKOUT_URL, account_field: ACCOUNT_FIELD }
};
