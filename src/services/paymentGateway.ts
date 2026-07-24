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
      extra,
    });
    return { provider, redirectUrl: r.url, ref: input.reference, gatewayOrderId: null, password: null, status: null };
  }
  const k = await kapital.createOrder({
    amount: input.amount,
    title: input.title,
    description: input.description,
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

// İadə (provider-ə görə).
export async function refundOrder(order: { gatewayProvider: string | null; gatewayRef: string | null; gatewayOrderId: number | null; gatewayPassword: string | null }, amount?: number): Promise<void> {
  if (order.gatewayProvider === 'yigim') {
    await yigim.refund(order.gatewayRef || '', amount);
    return;
  }
  await kapital.refund(order.gatewayOrderId!, order.gatewayPassword!, amount);
}
