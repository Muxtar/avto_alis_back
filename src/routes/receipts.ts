// E-KASSA ÇEKLƏRİ — QR ilə çek oxut, məhsulları saytda tap. Məntiq: services/ekassa.ts.
import { Router, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import fs from 'fs';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { processImages } from '../middleware/imageProcess';
import { receiptLimiter } from '../middleware/rateLimiter';
import { parseFiscalId, getReceipt, matchItems, readReceiptImage, type ReceiptData } from '../services/ekassa';

const router = Router();
const prisma = new PrismaClient();

async function respond(res: Response, userId: number, rec: { id: number; fiscalId: string; data: any; createdAt: Date }) {
  await prisma.receiptScan.upsert({ where: { userId_receiptId: { userId, receiptId: rec.id } }, create: { userId, receiptId: rec.id }, update: {} });
  const data = rec.data as ReceiptData;
  const matches = await matchItems(data.items || []);
  res.json({ success: true, receipt: { ...data, id: rec.id, fiscalId: rec.fiscalId, items: (data.items || []).map((it, i) => ({ ...it, ...matches[i] })) } });
}

// QR mətni / e-kassa linki / fiskal ID.
router.post('/receipts/scan', receiptLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const fiscalId = parseFiscalId(String(req.body?.text || ''));
    if (!fiscalId) { res.status(400).json({ success: false, message: 'Bu QR e-kassa çeki deyil. Çekin altındakı QR kodu oxudun (monitoring.e-kassa.gov.az linki).' }); return; }
    const rec = await getReceipt(fiscalId);
    await respond(res, req.adminId!, rec);
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// QR oxunmadı — kağız çekin FOTOSU birbaşa AI ilə oxunur (şəkil hash-i ilə keş).
router.post('/receipts/scan-photo', receiptLimiter, adminAuth, upload.single('image'), processImages, async (req: AuthRequest, res: Response) => {
  const file = req.file as Express.Multer.File | undefined;
  try {
    if (!file) { res.status(400).json({ success: false, message: 'Çekin şəklini seçin' }); return; }
    const buf = await fs.promises.readFile(file.path);
    const key = `photo-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24)}`;
    let rec = await prisma.scannedReceipt.findUnique({ where: { fiscalId: key } });
    if (!rec) {
      const data = await readReceiptImage(buf, 'image/jpeg', key);
      rec = await prisma.scannedReceipt.upsert({
        where: { fiscalId: key }, update: {},
        create: { fiscalId: key, storeName: data.store.objectName, voen: data.store.voen, total: data.total, data: data as unknown as Prisma.InputJsonValue },
      });
    }
    await respond(res, req.adminId!, rec);
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
  finally { if (file) fs.promises.unlink(file.path).catch(() => {}); }
});

// Diaqnostika (açıq, sirr yoxdur): server e-kassa portalına çata bilirmi, AI açarı qoyulubmu.
router.get('/receipts/diag', async (_req, res: Response) => {
  const started = Date.now();
  let portal: any = { ok: false };
  try {
    const r = await fetch('https://monitoring.e-kassa.gov.az/pks-monitoring/2.0.0/documents/BfnEuM65Cq4NXKKKPfL89ofPeX8pwJy32tNuowJLjCSE', { headers: { 'User-Lang': 'az' }, signal: AbortSignal.timeout(12000) });
    portal = { ok: r.status === 200, status: r.status, type: r.headers.get('content-type') };
  } catch (e: any) {
    portal = { ok: false, error: e?.name, code: e?.cause?.code || null, message: String(e?.cause?.message || e?.message || '').slice(0, 160) };
  }
  res.json({ portal: { ...portal, ms: Date.now() - started }, ai: { configured: !!process.env.ANTHROPIC_API_KEY }, node: process.version });
});

// Çeklərim.
router.get('/me/receipts', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const scans = await prisma.receiptScan.findMany({ where: { userId: req.adminId! }, orderBy: { createdAt: 'desc' }, take: 100, include: { receipt: true } });
    res.json({
      success: true,
      receipts: scans.map((s) => ({
        id: s.receipt.id, fiscalId: s.receipt.fiscalId, storeName: s.receipt.storeName, total: s.receipt.total,
        issuedAt: s.receipt.issuedAt, scannedAt: s.createdAt, itemCount: ((s.receipt.data as any)?.items || []).length,
      })),
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// Bir çek (yalnız özü skan etdiyi).
router.get('/me/receipts/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const scan = await prisma.receiptScan.findFirst({ where: { userId: req.adminId!, receiptId: id }, include: { receipt: true } });
    if (!scan) { res.status(404).json({ success: false, message: 'Çek tapılmadı' }); return; }
    await respond(res, req.adminId!, scan.receipt);
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.delete('/me/receipts/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.receiptScan.deleteMany({ where: { userId: req.adminId!, receiptId: parseInt(String(req.params.id)) } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
