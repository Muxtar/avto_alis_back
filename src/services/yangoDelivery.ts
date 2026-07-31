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

// Yango yük limiti (kq). Bundan ağır sifarişlər kuryerlə göndərilə bilməz.
export const YANGO_MAX_WEIGHT_KG = Number(process.env.YANGO_MAX_WEIGHT_KG || 50);

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
  opts: { method?: 'POST' | 'GET'; query?: Record<string, string>; body?: any } = {}
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  if (!TOKEN) return { ok: false, status: 0, data: null, error: 'YANGO_TOKEN qurulmayıb' };
  const method = opts.method || 'POST';
  const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
  const url = `${BASE}${PATH}${endpoint}${qs}`;
  // Timeout — Yango cavab verməzsə sorğu asılıb qalmasın (əks halda Railway 502 verir).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Accept-Language': LANG,
      },
      body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
      signal: controller.signal,
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
    const error = e?.name === 'AbortError' ? 'Yango cavab vermədi (vaxt bitdi, 15s)' : (e?.message || 'Yango şəbəkə xətası');
    return { ok: false, status: 0, data: null, error };
  } finally {
    clearTimeout(timer);
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

// Kuryerin canlı GPS mövqeyi (lat/lon/timestamp/speed/direction).
export async function getPerformerPosition(claimId: string) {
  return yreq('/claims/performer-position', { method: 'GET', query: { claim_id: claimId } });
}

// Ləğv şərtləri — pulsuz mümkündürmü?
export async function getCancelInfo(claimId: string) {
  return yreq('/claims/cancel-info', { query: { claim_id: claimId } });
}

// Claim-i ləğv et (cancel_state: 'free' | 'paid').
export async function cancelClaim(claimId: string, version: number, cancelState: 'free' | 'paid' = 'free') {
  return yreq('/claims/cancel', { query: { claim_id: claimId }, body: { version, cancel_state: cancelState } });
}

// Wolt-tipli izləmə linki — alıcı bu linkdən kuryeri canlı izləyir (destination nöqtəsi).
export async function getTrackingLinks(claimId: string) {
  return yreq('/claims/tracking-links', { method: 'GET', query: { claim_id: claimId } });
}

// Nöqtələr üzrə ETA (çatma vaxtı) + kuryer mövqeyi.
export async function getPointsEta(claimId: string) {
  return yreq('/claims/points-eta', { query: { claim_id: claimId } });
}

// Kuryerə zəng — müvəqqəti proksi nömrə qaytarır (phone + ext + ttl_seconds).
// point_id verilməzsə default (destination/təhvil nöqtəsi) götürülür.
export async function getDriverPhone(claimId: string, pointId?: number) {
  const body: any = { claim_id: claimId };
  if (pointId != null) body.point_id = pointId;
  return yreq('/driver-voiceforwarding', { body });
}

// Təhvil təsdiq kodu (Yango) — alıcı bunu kuryerə deyir.
export async function getConfirmationCode(claimId: string) {
  return yreq('/claims/confirmation_code', { body: { claim_id: claimId } });
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
