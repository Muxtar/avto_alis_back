// RƏY KONSULTASİYASI — AVTOMATİK SAYĞAC.
//
// Əvvəl vaxtı peşəkar əl ilə idarə edirdi («Başlat / Dayandır») və yalnız sayğac
// işləyəndə yazmaq olurdu. İndi növbə / vaxt təyini yoxdur:
//   • peşəkar sorğunu QƏBUL edən kimi vaxt axmağa başlayır;
//   • vaxt yalnız QARŞILIQLI yazışma zamanı işləyir: tərəflərdən HƏR HANSI BİRİ
//     IDLE müddətində yazmasa sayğac özü dayanır (vaxt gözləyir, itmir);
//   • hər iki tərəf yenidən yazanda sayğac özü davam edir.
// Beləliklə nə alıcı (cavab yazmayıb vaxtı uzatmaqla), nə də peşəkar (susub
// ödənilmiş vaxtı yandırmaqla) qarşı tərəfin hesabına qazana bilmir.
//
// Hesab: sayğac `runningSince`-dən işləyir və ən gec
//   min(alıcının son mesajı, peşəkarın son mesajı) + IDLE
// anına qədər sayılır — yəni söhbətin «qarşılıqlı» olduğu son an.
import { PrismaClient, ConsultationSession } from '@prisma/client';
import { emitToUser } from './callSignaling';

const prisma = new PrismaClient();

/** Tərəflərdən biri bu qədər yazmasa sayğac dayanır (saniyə). Standart 5 dəqiqə. */
export const CONSULT_IDLE_SECONDS = Math.max(60, Math.min(3600, Number(process.env.CONSULT_IDLE_SECONDS) || 300));

type S = Pick<ConsultationSession, 'id' | 'buyerId' | 'professionalId' | 'status' | 'runningSince' | 'consumedSeconds' | 'durationSeconds' | 'lastBuyerMsgAt' | 'lastProMsgAt' | 'paymentStatus' | 'startedAt'>;

/** Söhbətin qarşılıqlı sayıldığı son an. */
export function mutualUntil(s: Pick<S, 'runningSince' | 'lastBuyerMsgAt' | 'lastProMsgAt'>): number {
  const base = s.runningSince ? new Date(s.runningSince).getTime() : 0;
  const b = s.lastBuyerMsgAt ? new Date(s.lastBuyerMsgAt).getTime() : base;
  const p = s.lastProMsgAt ? new Date(s.lastProMsgAt).getTime() : base;
  return Math.min(b, p) + CONSULT_IDLE_SECONDS * 1000;
}

/** İndiyə qədər xərclənmiş saniyə (işləyən sayğacın sayılan hissəsi daxil). */
export function usedSeconds(s: Pick<S, 'status' | 'runningSince' | 'consumedSeconds' | 'durationSeconds' | 'lastBuyerMsgAt' | 'lastProMsgAt'>, now = Date.now()): number {
  if (s.status !== 'ACTIVE' || !s.runningSince) return s.consumedSeconds;
  const stop = Math.min(now, mutualUntil(s));
  const run = Math.max(0, Math.floor((stop - new Date(s.runningSince).getTime()) / 1000));
  return Math.min(s.durationSeconds, s.consumedSeconds + run);
}
export const remainingOf = (s: Parameters<typeof usedSeconds>[0], now = Date.now()) => Math.max(0, s.durationSeconds - usedSeconds(s, now));

/** Kim gözlənilir: sayğac dayanıbsa hansı tərəf yazmalıdır. */
export function waitingFor(s: Pick<S, 'status' | 'lastBuyerMsgAt' | 'lastProMsgAt'>, now = Date.now()): 'buyer' | 'professional' | 'both' | null {
  if (s.status !== 'PAUSED' && s.status !== 'PAID') return null;
  const fresh = (d: Date | null) => !!d && now - new Date(d).getTime() <= CONSULT_IDLE_SECONDS * 1000;
  const b = fresh(s.lastBuyerMsgAt), p = fresh(s.lastProMsgAt);
  return b && p ? null : !b && !p ? 'both' : b ? 'professional' : 'buyer';
}

function announce(s: { id: number; buyerId: number; professionalId: number | null }, status: string) {
  for (const uid of [s.buyerId, s.professionalId]) if (uid) emitToUser(uid, 'live:update', { kind: 'consultation', id: s.id, status, at: Date.now() });
}

/**
 * Sayğacı real vəziyyətə gətir: vaxt bitibsə ENDED, qarşılıqlı yazışma kəsilibsə
 * PAUSED (yalnız sayılan hissə xərclənir). Oxunuşda, mesajda və fon işində çağırılır.
 */
export async function syncClock<T extends S>(s: T): Promise<T> {
  if (s.status !== 'ACTIVE' || !s.runningSince) return s;
  const now = Date.now();
  const used = usedSeconds(s, now);
  if (used >= s.durationSeconds) {
    const up = await prisma.consultationSession.update({ where: { id: s.id }, data: { status: 'ENDED', consumedSeconds: s.durationSeconds, runningSince: null, endedAt: new Date() } });
    announce(s, 'ENDED');
    await prisma.notification.createMany({
      data: [
        { userId: s.buyerId, type: 'CONSULTATION', title: 'Konsultasiya bitdi', body: 'Vaxt tamamlandı. Rəy bildirə və ya şikayət edə bilərsiniz.', link: `/consultations/${s.id}` },
        ...(s.professionalId ? [{ userId: s.professionalId, type: 'CONSULTATION' as const, title: 'Konsultasiya bitdi', body: 'Seansın vaxtı tamamlandı.', link: `/consultations/${s.id}` }] : []),
      ],
    }).catch(() => {});
    return { ...s, ...up };
  }
  if (now > mutualUntil(s)) {
    const up = await prisma.consultationSession.update({ where: { id: s.id }, data: { status: 'PAUSED', consumedSeconds: used, runningSince: null } });
    announce(s, 'PAUSED');
    return { ...s, ...up };
  }
  return s;
}

/** Qəbul / ödəniş anı: sayğac başlayır, hər iki tərəf «indi buradadır» sayılır. */
export function startClockData(now = new Date()) {
  return { status: 'ACTIVE' as const, runningSince: now, lastBuyerMsgAt: now, lastProMsgAt: now };
}

/**
 * Seansda mesaj yazıldı. Əvvəl sayğac köhnə vəziyyətlə hesablanır, sonra
 * yazanın vaxt möhürü yenilənir; hər iki tərəf IDLE daxilində yazıbsa və vaxt
 * qalıbsa dayanmış sayğac davam edir.
 */
export async function touchClock(sessionId: number, senderId: number): Promise<void> {
  try {
    const raw = await prisma.consultationSession.findUnique({ where: { id: sessionId } });
    if (!raw || (raw.buyerId !== senderId && raw.professionalId !== senderId)) return;
    const s = await syncClock(raw);
    if (!['ACTIVE', 'PAUSED', 'PAID'].includes(s.status)) return;
    const now = new Date();
    const data: any = senderId === s.buyerId ? { lastBuyerMsgAt: now } : { lastProMsgAt: now };
    const other = senderId === s.buyerId ? s.lastProMsgAt : s.lastBuyerMsgAt;
    const otherFresh = !!other && now.getTime() - new Date(other).getTime() <= CONSULT_IDLE_SECONDS * 1000;
    const canRun = ['PAID', 'REFUND_PENDING'].includes(s.paymentStatus) && s.durationSeconds - s.consumedSeconds > 0;
    let resumed = false;
    if ((s.status === 'PAUSED' || s.status === 'PAID') && otherFresh && canRun) {
      Object.assign(data, { status: 'ACTIVE', runningSince: now, startedAt: s.startedAt || now });
      resumed = true;
    }
    await prisma.consultationSession.update({ where: { id: s.id }, data });
    if (resumed) announce(s, 'ACTIVE');
  } catch (e) {
    console.error('[consultClock] touchClock:', (e as any)?.message);
  }
}

/** Fon işi: bütün işləyən seansları yoxla (bitən / dayanmalı olan). */
export async function tickConsultClocks(): Promise<number> {
  try {
    const active = await prisma.consultationSession.findMany({ where: { status: 'ACTIVE', runningSince: { not: null } }, take: 500 });
    let changed = 0;
    for (const s of active) { const u = await syncClock(s); if (u.status !== 'ACTIVE') changed++; }
    return changed;
  } catch (e) {
    console.error('[consultClock] tick:', (e as any)?.message);
    return 0;
  }
}
