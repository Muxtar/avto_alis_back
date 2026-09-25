// Ödəniş şlüzü facade-i — YIĞIM (MAGNET) və ya Kapital Bank arasında seçim edir.
// Seçim: PAYMENT_GATEWAY env ('yigim' | 'kapital'). Qoyulmayıbsa YIĞIM
// konfiqurasiya olunubsa onu, yoxsa Kapital-ı işlədir.

import * as kapital from './kapital';
import * as yigim from './yigimPay';

export type Provider = 'kapital' | 'yigim';

export function activeProvider(): Provider {
  const choice = (process.env.PAYMENT_GATEWAY || '').toLowerCase();
  if (choice === 'yigim') return 'yigim';
  if (choice === 'kapital') return 'kapital';
  return yigim.isConfigured() ? 'yigim' : 'kapital';
}

export interface CreateInput {
  amount: number;        // AZN
  reference: string;     // bizim unikal checkout referansı (məs. "TX123")
  title?: string;
  description?: string;
  callbackBase: string;  // PUBLIC_BACKEND_URL
  language?: string;
  // Alıcı "kartı yadda saxla" seçibsə şlüzə save=y gedir və ödəniş
  // təsdiqlənəndə cavabda kart tokeni qayıdır. Yalnız YIĞIM dəstəkləyir.
  saveCard?: boolean;
  // Hissəli ödəniş — Kapital Bank təsvirdə «TAKSIT=N» görəndə ödənişi aylara bölür.
  // YIĞIM taksiti dəstəkləmir (getInstallmentConfig onu heç təklif etmir).
  installmentMonths?: number | null;
}

export interface CreatedPayment {
  provider: Provider;
  redirectUrl: string;       // müştərini yönəltmək üçün
  ref: string;               // saxlanacaq referans
  gatewayOrderId: number | null;
  password: string | null;
  status: string | null;
}

export async function createPayment(input: CreateInput): Promise<CreatedPayment> {
  const provider = activeProvider();
  if (provider === 'yigim') {
    // İstifadəçi WebView-da ödənişi bitirdikdən sonra saytına qayıtsın deyə
    // şablona back-url/fail-url ötürürük (callback ayrıca server webhook-udur).
    const fe = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const extra = `back-url=${fe}/payment/return?status=success;fail-url=${fe}/payment/return?status=failed`;
    const r = await yigim.createPayment({
      reference: input.reference,
      amount: input.amount,
      description: input.description,
      language: input.language,
      callbackUrl: `${input.callbackBase}/api/payment/yigim/callback`,
      type: 'SMS',
      saveCard: input.saveCard,
      extra,
    });
    return { provider, redirectUrl: r.url, ref: input.reference, gatewayOrderId: null, password: null, status: null };
  }
  if (input.installmentMonths && provider !== 'kapital') {
    throw new Error('Cari ödəniş şlüzü hissəli ödənişi dəstəkləmir');
  }
  const k = await kapital.createOrder({
    amount: input.amount,
    title: input.title,
    description: input.installmentMonths
      ? `${input.description || 'tradixai sifariş'}/TAKSIT=${input.installmentMonths}`
      : input.description,
    redirectUrl: `${input.callbackBase}/api/payment/callback`,
    language: input.language,
  });
  return { provider, redirectUrl: k.redirectUrl, ref: String(k.id), gatewayOrderId: k.id, password: k.password, status: k.status };
}

// Order qeydinə görə statusu yoxla (provider order-də saxlanılır).
export async function getStatus(order: { gatewayProvider: string | null; gatewayRef: string | null; gatewayOrderId: number | null }): Promise<{ status: string; paid: boolean }> {
  if (order.gatewayProvider === 'yigim') {
    const { status } = await yigim.getPaymentStatus(order.gatewayRef || '');
    return { status, paid: yigim.isPaidStatus(status) };
  }
  const { status } = await kapital.getOrderStatus(order.gatewayOrderId!);
  return { status: status || '', paid: kapital.isPaidStatus(status) };
}

// Şəbəkə/cavabsız xəta — pulun çıxıb-çıxmadığı bilinmir; alternativ yola keçmək OLMAZ.
function isTransportError(e: any): boolean {
  const msg = String(e?.message || '').toLowerCase();
  return e instanceof TypeError || /fetch failed|timeout|timed out|econn|socket hang up|aborted|enotfound|eai_again|\((5\d\d)\)/.test(msg);
}

// İadə (provider-ə görə).
//
// PULUN QAYTARILMASININ İKİ YOLU VAR və hansının işlədiyi ödənişin bank
// hesablaşmasından (settlement) keçib-keçmədiyindən asılıdır:
//   • YIĞIM: /payment/refund — yalnız settlement-dən SONRA; ondan əvvəl
//     /payment/cancel (blokun qaytarılması). Settlement-dən əvvəl refund
//     «System error» qaytarır.
//   • Kapital: Refund — settlement-dən sonra; eyni gün Reversal (reverse).
// Əvvəl yalnız refund çağırılırdı: satıcı təsdiqləmədiyi / ləğv etdiyi üçün
// avtomatik qaytarma ödənişdən qısa müddət sonra olanda (settlement hələ
// olmayıb) hər cəhd uğursuz olurdu və pul alıcıda ilişib qalırdı.
// İndi refund rədd edilsə eyni məbləğlə ləğv/reversal yoxlanılır. Təhlükəsizdir:
// ikisindən YALNIZ biri keçə bilər. Şəbəkə xətasında (nəticə bilinmir) ikinci
// yola keçilmir — ikiqat qaytarma riski olmasın.
export async function refundOrder(order: { gatewayProvider: string | null; gatewayRef: string | null; gatewayOrderId: number | null; gatewayPassword: string | null }, amount?: number): Promise<void> {
  if (order.gatewayProvider === 'yigim') {
    const ref = order.gatewayRef || '';
    try { await yigim.refund(ref, amount); return; }
    catch (e1: any) {
      if (isTransportError(e1)) throw e1;
      let st = '';
      try { st = (await yigim.getPaymentStatus(ref)).status; } catch { /* status alınmadı */ }
      try { await yigim.cancel(ref, amount); return; }
      catch (e2: any) {
        throw new Error(`YIĞIM refund: ${e1?.message}; cancel: ${e2?.message}${st ? ` (ödəniş statusu: ${st})` : ''}`);
      }
    }
  }
  try { await kapital.refund(order.gatewayOrderId!, order.gatewayPassword!, amount); }
  catch (e1: any) {
    if (isTransportError(e1)) throw e1;
    try { await kapital.reverse(order.gatewayOrderId!, order.gatewayPassword!, amount); }
    catch (e2: any) { throw new Error(`Kapital refund: ${e1?.message}; reversal: ${e2?.message}`); }
  }
}
