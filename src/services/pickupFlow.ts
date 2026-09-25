// MAĞAZADAN GÖTÜRMƏ (deliveryType=PICKUP) axını.
//
// Götürmədə «göndərmək» yoxdur, ona görə:
//   • satıcı «Mağazada təhvil verdim» deyir (daxildə SHIPPED + pickupHandedAt) →
//     alıcıya sorğu gedir: «Məhsulu götürdünüz?»;
//   • alıcı «Götürdüm» → DELIVERED (qaytarma müddəti buradan sayılır);
//     «Götürmədim» → mübahisə açılır, avtomatik təsdiq dayanır;
//   • alıcı PICKUP_CONFIRM_HOURS ərzində cavab verməsə sistem təsdiqləyir;
//   • alıcı satıcıdan əvvəl də «Götürdüm» deyə bilər (CONFIRMED → DELIVERED);
//   • satıcı alıcının təhvil kodunu yazaraq dərhal tamamlaya bilər.
import { PrismaClient } from '@prisma/client';
import { pushLive } from './live';
import { recordSettlement } from './settlement';

const prisma = new PrismaClient();
export const PICKUP_CONFIRM_HOURS = Number(process.env.PICKUP_CONFIRM_HOURS || 72);
// Götürmədə alıcı mağazaya gec gələ bilər — ödənilmiş sifarişin avtomatik ləğvi üçün daha uzun müddət.
export const PICKUP_DEADLINE_HOURS = Number(process.env.PICKUP_DEADLINE_HOURS || 168);

export function isPickup(o: { deliveryType: string | null }) { return o.deliveryType === 'PICKUP'; }

async function notify(userId: number, title: string, body: string, link = '/orders', toast?: string) {
  await prisma.notification.create({ data: { userId, type: 'ORDER', title, body, link } }).catch(() => {});
  pushLive(userId, { kind: 'order', toast: toast || title, tone: 'info' });
}

/** Satıcı sifarişi qəbul etdi — alıcıya «hazırdır, gəlib götürün» + kod. */
export async function onPickupReady(orderId: number) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { buyerId: true, pickupCode: true } });
  if (!o) return;
  await notify(o.buyerId, `Sifariş #${orderId} hazırdır 🏪`,
    `Satıcı sifarişi qəbul etdi — mağazadan götürə bilərsiniz.${o.pickupCode ? ` Təhvil kodunuz: ${o.pickupCode}` : ''} Götürəndə «Götürdüm» basın.`);
}

/** Satıcı «mağazada təhvil verdim» dedi — alıcıdan təsdiq istənir. */
export async function onPickupHandedOver(orderId: number) {
  const confirmBy = new Date(Date.now() + PICKUP_CONFIRM_HOURS * 3600 * 1000);
  const o = await prisma.order.update({ where: { id: orderId }, data: { pickupHandedAt: new Date(), pickupConfirmBy: confirmBy }, select: { buyerId: true } });
  await notify(o.buyerId, `Sifariş #${orderId}: məhsulu götürdünüz?`,
    `Satıcı məhsulu mağazada sizə təhvil verdiyini bildirdi. Götürmüsünüzsə «Götürdüm» basın; götürməmisinizsə «Götürmədim» — ${PICKUP_CONFIRM_HOURS} saat ərzində cavab verilməsə təhvil təsdiqlənmiş sayılır.`,
    '/orders', 'Satıcı təhvil verdiyini bildirdi — təsdiqləyin');
}

/** Alıcı «götürdüm» dedi (və ya sistem təsdiqlədi) — satıcıya xəbər. */
export async function onPickupReceived(orderId: number, by: 'BUYER' | 'SYSTEM') {
  const o = await prisma.order.update({ where: { id: orderId }, data: { pickupConfirmBy: null }, select: { sellerId: true, buyerId: true } });
  await notify(o.sellerId, `Sifariş #${orderId} götürüldü ✅`,
    by === 'BUYER' ? 'Alıcı məhsulu götürdüyünü təsdiqlədi.' : `Alıcı ${PICKUP_CONFIRM_HOURS} saat ərzində etiraz etmədiyi üçün təhvil avtomatik təsdiqləndi.`,
    '/orders?tab=selling');
  if (by === 'SYSTEM') {
    await notify(o.buyerId, `Sifariş #${orderId} təhvil alınmış sayıldı`, 'Etiraz edilmədiyi üçün təhvil təsdiqləndi. Problem varsa 14 gün ərzində qaytarma sorğusu göndərə bilərsiniz.', '/orders');
  }
}

/** Cavabsız qalan götürmələri təsdiqlə (hər 10 dəq). Açıq mübahisəsi olanlara toxunulmur. */
export async function autoConfirmPickups(): Promise<number> {
  const now = new Date();
  const rows = await prisma.order.findMany({
    where: { status: 'SHIPPED', deliveryType: 'PICKUP', pickupConfirmBy: { lt: now } },
    select: { id: true }, take: 100,
  });
  let n = 0;
  for (const r of rows) {
    const open = await prisma.complaint.count({ where: { orderId: r.id, status: { in: ['OPEN', 'AWAITING_SELLER', 'REVIEWING', 'EVIDENCE_REQUESTED'] } } });
    if (open) { await prisma.order.update({ where: { id: r.id }, data: { pickupConfirmBy: null } }); continue; }
    const upd = await prisma.order.updateMany({ where: { id: r.id, status: 'SHIPPED' }, data: { status: 'DELIVERED', deliveredAt: now, deliveryDeadline: null } });
    if (!upd.count) continue;
    await recordSettlement(r.id).catch(() => {});
    await onPickupReceived(r.id, 'SYSTEM');
    n++;
  }
  return n;
}
