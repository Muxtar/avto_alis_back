// YIĞIM Payment System — MAGNET Merchant API (v1.16) ödəniş şlüzü servisi.
// Sənəd: yigim.az / developer@yigim.az
//
// Autentifikasiya: X-Merchant + X-API-Key başlıqları (env-dən).
// Bütün çağırışlar GET-dir, cavab JSON (X-Type: JSON).
// Məbləğ qəpiklə göndərilir (5025 = 50.25 AZN), valyuta 944 = AZN.
//
// Railway → Variables (açar gələndə):
//   YIGIM_API_URL    = https://api.pay.yigim.az   (sandbox: https://sandbox.api.pay.yigim.az)
//   YIGIM_MERCHANT   = <YIĞIM verdiyi merchant adı>
//   YIGIM_API_KEY    = <YIĞIM verdiyi API açarı>
//   YIGIM_BILLER     = <YIĞIM verdiyi biller adı>
//   YIGIM_TEMPLATE   = <kart səhifəsi şablonu, məs. TPL0001>

const API_URL = (process.env.YIGIM_API_URL || 'https://sandbox.api.pay.yigim.az').replace(/\/$/, '');
const MERCHANT = process.env.YIGIM_MERCHANT || '';
const API_KEY = process.env.YIGIM_API_KEY || '';
const BILLER = process.env.YIGIM_BILLER || '';
const TEMPLATE = process.env.YIGIM_TEMPLATE || '';
const CURRENCY_AZN = '944';

export function isConfigured(): boolean {
  return !!(MERCHANT && API_KEY && BILLER && TEMPLATE);
}

function headers(): Record<string, string> {
  return { 'X-Merchant': MERCHANT, 'X-API-Key': API_KEY, 'X-Type': 'JSON' };
}

// GET sorğusu — query parametrlərlə. Cavab { response: {...} } formatındadır.
async function get(path: string, params: Record<string, string | number | undefined>): Promise<any> {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${API_URL}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { method: 'GET', headers: headers() });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  const r = data?.response ?? data;
  if (!res.ok || (r && typeof r.code !== 'undefined' && Number(r.code) !== 0 && r.url === undefined)) {
    const msg = (r && (r.message)) || `YIĞIM API xətası (${res.status})`;
    throw new Error(msg);
  }
  return r;
}

export interface YigimCreateInput {
  reference: string;     // bizim unikal sifariş ID-si (order id və ya checkout ref)
  amount: number;        // AZN (məs. 50.25) — qəpiyə çevriləcək
  description?: string;
  language?: string;     // az/en/ru
  callbackUrl: string;   // ödəniş statusu dəyişəndə webhook
  type?: 'SMS' | 'DMS';  // SMS = dərhal çəkilir, DMS = blokla→sonra çək
  saveCard?: boolean;
}

export interface YigimCreated { url: string; code: number; message: string; }

// 5.1 Ödəniş başlat → kart səhifəsinin URL-ini qaytarır.
export async function createPayment(input: YigimCreateInput): Promise<YigimCreated> {
  const coins = Math.round(input.amount * 100); // qəpik
  const r = await get('/payment/create', {
    reference: input.reference,
    type: input.type || 'SMS',
    save: input.saveCard ? 'y' : 'n',
    amount: coins,
    currency: CURRENCY_AZN,
    biller: BILLER,
    template: TEMPLATE,
    language: input.language || 'az',
    description: input.description,
    callback: input.callbackUrl,
  });
  return { url: r.url, code: Number(r.code ?? 0), message: r.message };
}

// 5.2 Ödəniş statusu.
export async function getPaymentStatus(reference: string): Promise<{ status: string; raw: any }> {
  const r = await get('/payment/status', { reference });
  return { status: String(r.status ?? ''), raw: r };
}

// 5.4 Capture (DMS bloklanmış məbləği çək).
export async function capture(reference: string, amount?: number): Promise<any> {
  return get('/payment/charge', { reference, amount: amount !== undefined ? Math.round(amount * 100) : undefined });
}

// 5.5 Ləğv (settlement-dən əvvəl bloku qaytar).
export async function cancel(reference: string, amount?: number): Promise<any> {
  return get('/payment/cancel', { reference, amount: amount !== undefined ? Math.round(amount * 100) : undefined });
}

// 5.6 Geri ödəniş (settlement-dən sonra).
export async function refund(reference: string, amount?: number): Promise<any> {
  return get('/payment/refund', { reference, amount: amount !== undefined ? Math.round(amount * 100) : undefined });
}

// 8.1 status "00" = uğurlu (Approved). S0–S7 ara vəziyyətlərdir.
export function isPaidStatus(status: string | undefined): boolean {
  return status === '00';
}
