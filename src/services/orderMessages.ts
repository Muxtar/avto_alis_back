// SİFARİŞ STATUSU BİLDİRİŞLƏRİ — bir yerdə, bir dildə.
//
// Əvvəl hər yol öz mətnini yazırdı və nəticə qarışıq idi:
//   • ləğvdə hər iki tərəfə «Sifariş rədd/ləğv edildi.» — KİM ləğv etdi, pul
//     qaytarılacaqmı — bilinmirdi;
//   • admin statusu dəyişəndə alıcıya «Sifariş #5: CANCELLED» (xam ingilis
//     kodu) gedirdi, satıcıya isə heç nə;
//   • kuryer «yola çıxdı» edəndə heç kim xəbər tutmurdu;
//   • mağazadan götürmədə «yola çıxdı» yazılırdı.
//
// Qayda: əməliyyatı EDƏN tərəfə bildiriş getmir (öz etdiyini bilir), QARŞI
// tərəf(lər)ə isə kimin nə etdiyi və pulun taleyi açıq yazılır.
import { PrismaClient } from '@prisma/client';
import { pushLive } from './live';

const prisma = new PrismaClient();

export type OrderActor = 'BUYER' | 'SELLER' | 'ADMIN' | 'COURIER' | 'SYSTEM';

interface OrderLike {
  id: number;
  buyerId: number;
  sellerId: number;
  courierId?: number | null;
  status: string;              // ƏVVƏLKİ status (dəyişiklikdən əvvəl)
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  deliveryType?: string | null;
}

interface Msg { title: string; body: string }

export const BUYER_LINK = '/orders';
export const SELLER_LINK = '/orders?tab=selling';

async function send(userId: number, m: Msg, link: string, tone: 'success' | 'error' | 'info') {
  await prisma.notification.create({ data: { userId, type: 'ORDER', title: m.title, body: m.body, link } }).catch(() => {});
  return { toast: m.title, tone };
}

/** Ləğvdə alıcıya pulun taleyi. `refundOk` — qaytarma cəhdinin nəticəsi. */
function refundPhrase(o: OrderLike, refundOk?: boolean | null): string {
  const paid = o.paymentStatus === 'PAID' && o.paymentMethod !== 'CASH';
  if (!paid) return o.paymentMethod === 'CASH' ? ' Ödəniş alınmayıb.' : '';
  return refundOk === false
    ? ' Ödənişin qaytarılması emal olunur — qısa müddətdə hesabınıza qayıdacaq.'
    : ' Ödənişiniz geri qaytarılır.';
}

/**
 * Status dəyişdi — qarşı tərəflərə bildiriş + hər iki tərəfin açıq səhifəsinə
 * canlı yeniləmə.
 *
 * `quiet.buyer / quiet.seller` — həmin tərəfə mətn BAŞQA yerdən gedir
 * (məs. mağazadan götürmə axını öz ətraflı bildirişini göndərir); burada
 * yalnız səhifəsi yenilənir.
 */
export async function notifyOrderStatus(
  o: OrderLike,
  next: string,
  actor: OrderActor,
  opts: { refundOk?: boolean | null; quiet?: { buyer?: boolean; seller?: boolean } } = {},
): Promise<void> {
  const n = `Sifariş #${o.id}`;
  const pickup = o.deliveryType === 'PICKUP';
  const paid = o.paymentStatus === 'PAID' && o.paymentMethod !== 'CASH';
  let buyer: Msg | null = null;
  let seller: Msg | null = null;
  let courier: Msg | null = null;
  let tone: 'success' | 'error' | 'info' = 'info';

  if (next === 'CONFIRMED') {
    if (actor !== 'BUYER') buyer = {
      title: `${n} təsdiqləndi`,
      body: pickup ? 'Satıcı sifarişinizi qəbul etdi — mağazadan götürə bilərsiniz.' : 'Satıcı sifarişinizi qəbul etdi və hazırlayır.',
    };
    if (actor === 'ADMIN') seller = { title: `${n} təsdiqləndi`, body: 'Administrator sifarişi təsdiqlənmiş kimi qeyd etdi. Məhsulu hazırlayın.' };
  } else if (next === 'SHIPPED') {
    if (actor !== 'BUYER') buyer = pickup
      ? { title: `${n}: məhsulu götürdünüz?`, body: 'Satıcı məhsulu sizə təhvil verdiyini bildirdi. Götürmüsünüzsə «Götürdüm» düyməsini basın.' }
      : { title: `${n} yola çıxdı 🚚`, body: 'Sifarişiniz yoldadır. Məhsulu alanda «Təhvil aldım» düyməsini basın.' };
    if (actor === 'ADMIN') seller = { title: `${n} yola çıxdı`, body: 'Administrator sifarişi «yolda» kimi qeyd etdi.' };
    if (actor === 'COURIER') seller = { title: `${n} yola çıxdı`, body: 'Kuryer məhsulu götürdü və alıcıya aparır.' };
  } else if (next === 'DELIVERED') {
    tone = 'success';
    if (actor === 'BUYER') {
      seller = { title: `${n} təhvil alındı ✅`, body: pickup ? 'Alıcı məhsulu götürdüyünü təsdiqlədi.' : 'Alıcı sifarişi təhvil aldığını təsdiqlədi.' };
      // Alıcının özünə — yalnız rəy xatırlatması (statusu özü dəyişib).
      buyer = { title: `${n} tamamlandı ✓`, body: 'Məhsula və satıcıya rəy yazmağınız digər alıcılara kömək edir. Problem varsa 14 gün ərzində qaytarma sorğusu göndərə bilərsiniz.' };
    } else {
      buyer = { title: `${n} çatdırıldı ✓`, body: 'Sifarişiniz təhvil verildi. Məhsula rəy yaza bilərsiniz; problem varsa 14 gün ərzində qaytarma sorğusu göndərin.' };
      if (actor === 'COURIER') seller = { title: `${n} çatdırıldı ✅`, body: 'Kuryer sifarişi alıcıya təhvil verdi.' };
      if (actor === 'ADMIN') seller = { title: `${n} çatdırıldı ✅`, body: 'Administrator sifarişi «çatdırıldı» kimi qeyd etdi.' };
    }
  } else if (next === 'CANCELLED') {
    tone = 'error';
    const title = `${n} ləğv edildi`;
    const refund = refundPhrase(o, opts.refundOk);
    const sellerMoney = paid ? ' Ödəniş alıcıya qaytarılır.' : '';
    if (actor === 'BUYER') {
      seller = { title, body: `Alıcı sifarişi ləğv etdi.${sellerMoney}${o.status !== 'PENDING' ? ' Məhsulu göndərməyin.' : ''}` };
      // Alıcının özünə yalnız qaytarma GECİKƏNDƏ yazılır; uğurlu qaytarmanın
      // bildirişini (məbləğlə) qaytarma servisi özü göndərir.
      if (paid && opts.refundOk === false) buyer = { title, body: `Sifarişi ləğv etdiniz.${refund}` };
    } else if (actor === 'SELLER') {
      buyer = { title, body: `${o.status === 'PENDING' ? 'Satıcı sifarişinizi qəbul etmədi.' : 'Satıcı sifarişinizi ləğv etdi.'}${refund}` };
    } else if (actor === 'ADMIN') {
      buyer = { title, body: `Sifarişiniz administrator tərəfindən ləğv edildi.${refund}` };
      seller = { title, body: `Sifariş administrator tərəfindən ləğv edildi.${sellerMoney}` };
    } else {
      buyer = { title, body: `Sifarişiniz ləğv edildi.${refund}` };
      seller = { title, body: `Sifariş ləğv edildi.${sellerMoney}` };
    }
    if (o.courierId && actor !== 'COURIER') courier = { title, body: 'Bu sifariş ləğv olundu — çatdırmağa ehtiyac yoxdur.' };
  } else if (next === 'PENDING') {
    const m = { title: `${n} yenidən gözləmədədir`, body: 'Administrator sifarişi «gözləmədə» statusuna qaytardı.' };
    buyer = m; seller = m;
  }

  const bLive = buyer && !opts.quiet?.buyer ? await send(o.buyerId, buyer, BUYER_LINK, tone) : null;
  const sLive = seller && !opts.quiet?.seller ? await send(o.sellerId, seller, SELLER_LINK, tone) : null;
  // Hər iki tərəfin açıq «Sifarişlər» səhifəsi yenilənsin (bildiriş olmasa da).
  pushLive(o.buyerId, { kind: 'order', id: o.id, status: next, ...(bLive && actor !== 'BUYER' ? bLive : {}) });
  pushLive(o.sellerId, { kind: 'order', id: o.id, status: next, ...(sLive && actor !== 'SELLER' ? sLive : {}) });
  if (o.courierId) {
    const cLive = courier ? await send(o.courierId, courier, '/orders', tone) : null;
    pushLive(o.courierId, { kind: 'order', id: o.id, status: next, ...(cLive || {}) });
  }
}
