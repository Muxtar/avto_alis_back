// Kapital Bank E-commerce (HPP) ödəniş şlüzü servisi.
// Sənəd: txpgtst.kapitalbank.az (test) / e-commerce.kapitalbank.az (prod).
// BÜTÜN çağırışlar yalnız backend-dən gedir; merchant parolu .env-dədir.

const API_URL = process.env.KAPITAL_API_URL || 'https://txpgtst.kapitalbank.az/api';
const USERNAME = process.env.KAPITAL_USERNAME || 'TerminalSys/kapital';
const PASSWORD = process.env.KAPITAL_PASSWORD || 'kapital123';

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
}

async function request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.errorDescription || data.message)) || `Kapital API xətası (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

export interface CreateOrderInput {
  amount: number;
  description?: string;
  title?: string;
  redirectUrl: string;   // hppRedirectUrl — ödənişdən sonra bank bura yönəldir
  language?: string;
  typeRid?: 'Order_SMS' | 'Order_DMS' | 'OCT';
}

export interface CreatedOrder {
  id: number;
  hppUrl: string;
  password: string;
  status: string;
  redirectUrl: string;   // müştərini yönəltmək üçün hazır link
}

// 1) Sifariş yarat (adi alış — Order_SMS).
export async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const data = await request('/order', 'POST', {
    order: {
      typeRid: input.typeRid || 'Order_SMS',
      amount: input.amount.toFixed(2),
      currency: 'AZN',
      language: input.language || 'az',
      title: input.title || 'AvtoBazar',
      description: input.description || 'AvtoBazar sifariş',
      hppRedirectUrl: input.redirectUrl,
    },
  });
  const o = data.order;
  // hppUrl artıq /flex ilə bitir → birbaşa id+password əlavə edirik.
  const redirectUrl = `${o.hppUrl}?id=${o.id}&password=${encodeURIComponent(o.password)}`;
  return { id: o.id, hppUrl: o.hppUrl, password: o.password, status: o.status, redirectUrl };
}

// 2) Sifariş statusunu yoxla (callback-i təsdiqləmək üçün — VACİBDİR).
export async function getOrderStatus(orderId: number): Promise<{ status: string; raw: any }> {
  const data = await request(`/order/${orderId}?orderDetailLevel=2`, 'GET');
  return { status: data.order?.status, raw: data };
}

// 3) İadə (tam və ya qismən) — exec-tran, type=Refund.
export async function refund(orderId: number, password: string, amount?: number): Promise<any> {
  const tran: any = { phase: 'Single', type: 'Refund' };
  if (amount !== undefined) tran.amount = amount.toFixed(2);
  return request(`/order/${orderId}/exec-tran?password=${encodeURIComponent(password)}`, 'POST', { tran });
}

// 4) Reversal — eyni gün ləğv (Full/Partial).
export async function reverse(orderId: number, password: string, amount?: number): Promise<any> {
  const tran: any = { phase: 'Single', voidKind: amount !== undefined ? 'Partial' : 'Full' };
  if (amount !== undefined) tran.amount = amount.toFixed(2);
  return request(`/order/${orderId}/exec-tran?password=${encodeURIComponent(password)}`, 'POST', { tran });
}

// Ödəniş uğurlu sayılan statuslar.
export function isPaidStatus(status: string | undefined): boolean {
  return status === 'FullyPaid' || status === 'Paid';
}
