// Satıcı hesablaşması (settlement) — hər ödənilmiş sifariş üçün ledger qeydi,
// platforma komissiyası, satıcı balansı və payout məntiqi.
//
// Axın:
//   Sifariş PAID → ledger yaranır (PENDING). Kart isə heldByPlatform=true
//     (platforma pulu saxlayır, satıcıya net borcludur); nağd isə false
//     (satıcı pulu özü alıb, platformaya komissiya borcludur).
//   Sifariş DELIVERED → ledger AVAILABLE (satıcıya ödənilə bilər).
//   Sifariş CANCELLED/REFUNDED → ledger REVERSED (balansdan çıxır).
//   Admin payout → AVAILABLE + heldByPlatform ledger-lər PAID_OUT olur.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Komissiya faizi — Setting cədvəlində `commission_percent` (default 0).
export async function getCommissionPercent(): Promise<number> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: 'commission_percent' } });
    const n = row ? parseFloat(row.value) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0;
  } catch { return 0; }
}
export async function setCommissionPercent(percent: number): Promise<number> {
  const p = Math.max(0, Math.min(100, Math.round(percent * 100) / 100));
  await prisma.setting.upsert({ where: { key: 'commission_percent' }, update: { value: String(p) }, create: { key: 'commission_percent', value: String(p) } });
  return p;
}

// Sifarişin cari vəziyyətinə görə ledger-i idempotent yarat/yenilə.
// Sifariş dəyişən hər əsas nöqtədə (PAID/DELIVERED/CANCELLED/REFUNDED) çağırılır.
export async function recordSettlement(orderId: number): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, sellerId: true, buyerId: true, total: true, status: true,
        paymentStatus: true, paymentMethod: true,
        // Hesablaşma BİZNES üzrə qruplaşdırılır — ödəniş biznesin bank hesabına gedir.
        items: { select: { listing: { select: { businessId: true } } }, take: 1 },
      },
    });
    if (!order) return;
    const existing = await prisma.sellerLedger.findUnique({ where: { orderId } });

    // Hələ ödənilməyibsə ledger yaratmırıq (yalnız PAID sifarişlər hesablaşır).
    if (order.paymentStatus !== 'PAID') {
      // Ödənildikdən sonra FAILED/geri qayıtsa REVERSED et.
      if (existing && existing.status !== 'REVERSED' && existing.status !== 'PAID_OUT') {
        await prisma.sellerLedger.update({ where: { orderId }, data: { status: 'REVERSED' } });
      }
      return;
    }

    // Hədəf status: ləğv/refund → REVERSED; çatdırılıb → AVAILABLE; əks halda PENDING.
    const reversed = order.status === 'CANCELLED' || order.paymentStatus === ('REFUNDED' as any);
    const delivered = order.status === 'DELIVERED';
    const targetStatus = reversed ? 'REVERSED' : delivered ? 'AVAILABLE' : 'PENDING';

    if (!existing) {
      const rate = await getCommissionPercent();
      const gross = order.total || 0;
      const commission = Math.round(gross * rate) / 100;
      const net = Math.round((gross - commission) * 100) / 100;
      await prisma.sellerLedger.create({
        data: {
          sellerId: order.sellerId, orderId: order.id, buyerId: order.buyerId,
          businessId: order.items[0]?.listing?.businessId ?? null,
          grossAmount: gross, commissionRate: rate, commission, netAmount: net,
          heldByPlatform: order.paymentMethod === 'CARD',
          status: targetStatus as any,
        },
      });
      return;
    }

    // Ödənilmiş ledger var — statusu köçür (PAID_OUT toxunulmaz qalır).
    if (existing.status === 'PAID_OUT') return;
    if (existing.status !== targetStatus) {
      await prisma.sellerLedger.update({ where: { orderId }, data: { status: targetStatus as any } });
    }
  } catch (e) {
    console.error('[settlement] recordSettlement xəta:', (e as any)?.message);
  }
}

// Bir neçə sifariş üçün (checkout-da toplu).
export async function recordSettlementMany(orderIds: number[]): Promise<void> {
  for (const id of orderIds) await recordSettlement(id);
}

// Satıcının balans xülasəsi.
export async function sellerBalance(sellerId: number) {
  const rows = await prisma.sellerLedger.findMany({ where: { sellerId }, select: { status: true, netAmount: true, commission: true, heldByPlatform: true } });
  let available = 0, pending = 0, paidOut = 0, commissionDueCash = 0;
  for (const r of rows) {
    if (!r.heldByPlatform) { if (r.status !== 'REVERSED') commissionDueCash += r.commission; continue; }
    if (r.status === 'AVAILABLE') available += r.netAmount;
    else if (r.status === 'PENDING') pending += r.netAmount;
    else if (r.status === 'PAID_OUT') paidOut += r.netAmount;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { available: r2(available), pending: r2(pending), paidOut: r2(paidOut), commissionDueCash: r2(commissionDueCash) };
}

// Payout yarat — satıcının AVAILABLE + heldByPlatform ledger-lərini PAID_OUT et.
export async function createPayout(sellerId: number, adminId: number, adminName: string, method?: string, reference?: string) {
  const ledgers = await prisma.sellerLedger.findMany({ where: { sellerId, status: 'AVAILABLE', heldByPlatform: true } });
  const amount = Math.round(ledgers.reduce((s, l) => s + l.netAmount, 0) * 100) / 100;
  if (amount <= 0) throw new Error('Ödəniləcək mövcud balans yoxdur');
  const payout = await prisma.payout.create({
    data: { sellerId, amount, method: method || null, reference: reference || null, createdById: adminId, createdName: adminName },
  });
  await prisma.sellerLedger.updateMany({ where: { id: { in: ledgers.map((l) => l.id) } }, data: { status: 'PAID_OUT', payoutId: payout.id } });
  return payout;
}
