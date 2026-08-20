// HÜQUQİ SƏNƏDLƏR VƏ QƏBUL QEYDİ.
//
// Sənədlərin mətni bazadadır (admin dəyişə bilər), hər dəyişiklik yeni VERSİYA
// yaradır. Qəbul qeydi versiyaya bağlanır — mübahisədə "hansı mətni qəbul
// etmişdi?" sualının cavabı olsun.
//
// Qayda: alış üçün MƏCBURİ sənədlər qəbul edilməyibsə sifariş verilə bilməz.
// Qeydiyyat anında qəbul MƏCBURİ DEYİL — istifadəçi keçə bilər, amma alış
// anında qarşısına yenidən çıxır və qəbul etmədən keçə bilmir.

import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

export type LegalSlug = 'user-agreement' | 'commission-rules' | 'return-rules' | 'seller-agreement';

/** İlk açılışda sənədləri bazaya yaz (yalnız yoxdursa — mövcud mətni ƏZMİR). */
export async function seedLegalDocuments(): Promise<void> {
  try {
    const file = path.join(__dirname, '..', 'data', 'legalDocuments.json');
    if (!fs.existsSync(file)) return;
    const docs: { slug: string; title: string; body: string; requiredForPurchase: boolean }[] =
      JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const d of docs) {
      const exists = await prisma.legalDocument.findFirst({ where: { slug: d.slug } });
      if (exists) continue;   // admin sonradan dəyişibsə üstünə yazmırıq
      await prisma.legalDocument.create({
        data: { slug: d.slug, version: 1, title: d.title, body: d.body, requiredForPurchase: d.requiredForPurchase, isActive: true },
      });
      console.log(`[legal] "${d.slug}" sənədi yazıldı (v1)`);
    }
  } catch (e: any) {
    console.error('[legal] seed:', e?.message);
  }
}

/** Qüvvədə olan sənədlər (ən son versiya). */
export async function activeDocuments(slugs?: string[]) {
  return prisma.legalDocument.findMany({
    where: { isActive: true, ...(slugs?.length ? { slug: { in: slugs } } : {}) },
    orderBy: [{ slug: 'asc' }, { version: 'desc' }],
    distinct: ['slug'],
  });
}

/**
 * İstifadəçinin QƏBUL ETMƏDİYİ məcburi sənədlər.
 * Boş massiv qayıdırsa — alışa icazə var.
 */
export async function missingRequiredConsents(userId: number) {
  const required = await prisma.legalDocument.findMany({
    where: { isActive: true, requiredForPurchase: true },
    orderBy: [{ slug: 'asc' }, { version: 'desc' }],
    distinct: ['slug'],
    select: { id: true, slug: true, version: true, title: true },
  });
  if (!required.length) return [];
  const accepted = await prisma.userConsent.findMany({
    where: { userId, documentId: { in: required.map((d) => d.id) } },
    select: { documentId: true },
  });
  const ok = new Set(accepted.map((a) => a.documentId));
  return required.filter((d) => !ok.has(d.id));
}

/** Qəbulu qeyd et — təkrar çağırış təhlükəsizdir (upsert). */
export async function recordConsents(
  userId: number, slugs: string[], ip?: string, userAgent?: string,
): Promise<number> {
  if (!slugs?.length) return 0;
  const docs = await prisma.legalDocument.findMany({
    where: { slug: { in: slugs }, isActive: true },
    orderBy: [{ slug: 'asc' }, { version: 'desc' }],
    distinct: ['slug'],
  });
  let n = 0;
  for (const d of docs) {
    await prisma.userConsent.upsert({
      where: { userId_documentId: { userId, documentId: d.id } },
      create: { userId, documentId: d.id, slug: d.slug, version: d.version, ip: ip?.slice(0, 64) || null, userAgent: userAgent?.slice(0, 300) || null },
      update: {},   // ilk qəbulun vaxtı və IP-si dəyişmir
    }).catch(() => {});
    n++;
  }
  return n;
}

/** Sorğudan həqiqi IP — Railway/Cloudflare arxasında olduğumuz üçün başlıqdan. */
export function clientIp(req: any): string | undefined {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || req.socket?.remoteAddress || undefined;
}
