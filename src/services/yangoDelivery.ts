// Yango (Yandex Delivery) Express API inteqrasiyası.
// Sənəd: https://yandex.com/support/delivery-profile/en/api/express/quickstart
// Token KODA YAZILMIR — YANGO_TOKEN env dəyişənindən oxunur (Railway-də qoyulmalıdır).

const BASE = process.env.YANGO_BASE_URL || 'https://b2b.taxi.yandex.net';
const PATH = '/b2b/cargo/integration/v2';
const TOKEN = process.env.YANGO_TOKEN || '';
const LANG = process.env.YANGO_LANG || 'en';

export function isYangoConfigured(): boolean {
  return !!TOKEN;
}

// [longitude, latitude] — Yango koordinatları belə gözləyir.
export type Geo = [number, number];

export interface YangoContact {
  name: string;
  phone: string; // +994... (E.164)
}
export interface YangoPoint {
  fullname: string;
  coordinates: Geo;
  contact: YangoContact;
}
export interface YangoItem {
  title: string;
  quantity: number;
  costValue: string; // "12.50"
  costCurrency: string; // "AZN"
  weightKg?: number;
}

async function yreq<T = any>(
  endpoint: string,
  opts: { query?: Record<string, string>; body?: any } = {}
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  if (!TOKEN) return { ok: false, status: 0, data: null, error: 'YANGO_TOKEN qurulmayıb' };
  const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
  const url = `${BASE}${PATH}${endpoint}${qs}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Accept-Language': LANG,
      },
      body: JSON.stringify(opts.body ?? {}),
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const msg = data?.message || data?.code || `Yango xətası (HTTP ${res.status})`;
      return { ok: false, status: res.status, data, error: msg };
    }
    return { ok: true, status: res.status, data };
  } catch (e: any) {
    return { ok: false, status: 0, data: null, error: e.message };
  }
}

// Qiymət təxmini (claim yaratmadan). "check-price" — Rusiyadan kənar ölkələr üçün.
export async function checkPrice(params: {
  source: Geo; destination: Geo; weightKg?: number; taxiClass?: string;
}) {
  const body = {
    route_points: [
      { id: 1, coordinates: params.source, fullname: 'source' },
      { id: 2, coordinates: params.destination, fullname: 'destination' },
    ],
    items: [
      { size: { length: 0.2, width: 0.2, height: 0.2 }, weight: params.weightKg || 1, quantity: 1, pickup_point: 1, dropoff_point: 2 },
    ],
    requirements: { taxi_class: params.taxiClass || 'express' },
  };
  return yreq('/check-price', { body });
}

// Claim (sifariş) yarat.
export async function createClaim(params: {
  requestId: string;
  source: YangoPoint;
  destination: YangoPoint;
  items: YangoItem[];
  emergencyContact: YangoContact;
  taxiClass?: string;
  comment?: string;
}) {
  const body: any = {
    route_points: [
      {
        point_id: 1, visit_order: 1, type: 'source',
        address: { fullname: params.source.fullname, coordinates: params.source.coordinates },
        contact: params.source.contact,
      },
      {
        point_id: 2, visit_order: 2, type: 'destination',
        address: { fullname: params.destination.fullname, coordinates: params.destination.coordinates },
        contact: params.destination.contact,
      },
    ],
    items: params.items.map((it) => ({
      title: it.title,
      quantity: it.quantity,
      cost_value: it.costValue,
      cost_currency: it.costCurrency,
      weight: it.weightKg || 1,
      pickup_point: 1,
      droppof_point: 2, // Yango API-də sahə adı belə yazılıb (sic)
    })),
    client_requirements: { taxi_class: params.taxiClass || 'express' },
    emergency_contact: params.emergencyContact,
  };
  if (params.comment) body.comment = params.comment;
  return yreq('/claims/create', { query: { request_id: params.requestId }, body });
}

// Claim-i təsdiqlə (kuryer axtarışını başladır).
export async function acceptClaim(claimId: string, version: number) {
  return yreq('/claims/accept', { query: { claim_id: claimId }, body: { version } });
}

// Claim statusu + kuryer/marşrut məlumatı.
export async function getClaimInfo(claimId: string) {
  return yreq('/claims/info', { query: { claim_id: claimId } });
}

// Claim-i ləğv et (cancel_state: 'free' | 'paid').
export async function cancelClaim(claimId: string, version: number, cancelState: 'free' | 'paid' = 'free') {
  return yreq('/claims/cancel', { query: { claim_id: claimId }, body: { version, cancel_state: cancelState } });
}

// Yango statusunu bizim OrderStatus-a uyğunlaşdır (avtomatik sinxron üçün).
export function mapYangoStatus(yango: string): 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | null {
  switch (yango) {
    case 'performer_found':
    case 'performer_draft':
    case 'pickup_arrived':
    case 'ready_for_pickup_confirmation':
      return 'CONFIRMED';
    case 'pickuped':
    case 'delivery_arrived':
    case 'ready_for_delivery_confirmation':
      return 'SHIPPED';
    case 'delivered':
    case 'delivered_finish':
      return 'DELIVERED';
    case 'cancelled':
    case 'cancelled_by_taxi':
    case 'cancelled_with_payment':
    case 'failed':
      return 'CANCELLED';
    default:
      return null;
  }
}
