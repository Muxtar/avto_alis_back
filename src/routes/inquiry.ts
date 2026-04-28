import { Router, Response } from 'express';
import { PrismaClient, UserType } from '@prisma/client';
import { adminAuth, requireType, requireSellerVerified, AuthRequest } from '../middleware/auth';
import { analyzeRequest, chatMessage } from '../services/deepseek';
import { findRelevantSellers } from '../services/sellerMatcher';

const router = Router();
const prisma = new PrismaClient();

// Smart chat - DeepSeek mesaji analiz eder, inquiry mi sohbet mi karar verir
router.post('/chat', requireType([UserType.CAR_OWNER]), async (req: AuthRequest, res: Response) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) {
      res.status(400).json({ success: false, message: 'Mesaj mətni tələb olunur' });
      return;
    }

    // DeepSeek'e sor: bu bir inquiry mi yoksa sohbet mi?
    const chatResult = await chatMessage(text.trim());

    if (chatResult.type === 'chat') {
      // Sohbet cevabi - inquiry olusturma
      res.json({ success: true, type: 'chat', reply: chatResult.reply });
      return;
    }

    // Inquiry - analiz et ve saticilara gonder
    const aiAnalysis = await analyzeRequest(text.trim());
    const sellerIds = await findRelevantSellers(aiAnalysis, req.adminId!);

    if (sellerIds.length === 0) {
      res.json({
        success: true,
        type: 'no_sellers',
        reply: aiAnalysis.summary || text,
        aiAnalysis,
      });
      return;
    }

    const inquiry = await prisma.inquiry.create({
      data: {
        buyerId: req.adminId!,
        rawText: text.trim(),
        aiAnalysis: aiAnalysis as any,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        targetSellers: {
          create: sellerIds.map(sellerId => ({ sellerId })),
        },
      },
    });

    res.json({
      success: true,
      type: 'inquiry',
      inquiry,
      aiAnalysis,
      matchedSellers: sellerIds.length,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Create inquiry (buyer) - direct inquiry creation
router.post('/inquiries', requireType([UserType.CAR_OWNER]), async (req: AuthRequest, res: Response) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) {
      res.status(400).json({ success: false, message: 'Sorğu mətni tələb olunur' });
      return;
    }

    // AI ile analiz et
    const aiAnalysis = await analyzeRequest(text.trim());

    // Uygun saticilari bul
    const sellerIds = await findRelevantSellers(aiAnalysis, req.adminId!);

    // Inquiry olustur
    const inquiry = await prisma.inquiry.create({
      data: {
        buyerId: req.adminId!,
        rawText: text.trim(),
        aiAnalysis: aiAnalysis as any,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 gun
        targetSellers: {
          create: sellerIds.map(sellerId => ({ sellerId })),
        },
      },
      include: {
        targetSellers: { include: { seller: { select: { id: true, name: true, type: true } } } },
      },
    });

    res.status(201).json({
      success: true,
      inquiry,
      aiAnalysis,
      matchedSellers: sellerIds.length,
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get my inquiries (buyer)
router.get('/inquiries/my', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const inquiries = await prisma.inquiry.findMany({
      where: { buyerId: req.adminId! },
      include: {
        offers: {
          include: {
            seller: { select: { id: true, name: true, phone: true, type: true } },
            listing: { select: { id: true, title: true, price: true, images: true } },
          },
          orderBy: { price: 'asc' },
        },
        targetSellers: { select: { sellerId: true, seen: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ inquiries });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get received inquiries (seller)
router.get('/inquiries/received', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const targets = await prisma.inquiryTarget.findMany({
      where: { sellerId: req.adminId! },
      include: {
        inquiry: {
          include: {
            buyer: { select: { id: true, name: true, phone: true, type: true } },
            offers: {
              where: { sellerId: req.adminId! },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Mark as seen
    await prisma.inquiryTarget.updateMany({
      where: { sellerId: req.adminId!, seen: false },
      data: { seen: true },
    });

    const inquiries = targets.map(t => ({
      ...t.inquiry,
      myOffer: t.inquiry.offers.length > 0 ? t.inquiry.offers[0] : null,
    }));

    res.json({ inquiries });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Submit offer (seller) - requires verified seller (MECHANIC or PARTS_SELLER)
router.post('/inquiries/:id/offer', requireSellerVerified, async (req: AuthRequest, res: Response) => {
  try {
    const inquiryId = parseInt(req.params.id);
    const { price, message, listingId } = req.body;

    if (!price || price <= 0) {
      res.status(400).json({ success: false, message: 'Qiymət tələb olunur' });
      return;
    }

    // Satici bu sorgunun hedefi olmalidir
    const target = await prisma.inquiryTarget.findUnique({
      where: { inquiryId_sellerId: { inquiryId, sellerId: req.adminId! } },
    });
    if (!target) {
      res.status(403).json({ success: false, message: 'Bu sorğu sizə göndərilməyib' });
      return;
    }

    // Sorgu OPEN olmalidir
    const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId } });
    if (!inquiry || inquiry.status !== 'OPEN') {
      res.status(400).json({ success: false, message: 'Bu sorğu artıq bağlanıb' });
      return;
    }

    // Ayni satici tekrar teklif veremez
    const existing = await prisma.inquiryOffer.findFirst({
      where: { inquiryId, sellerId: req.adminId!, status: { not: 'WITHDRAWN' } },
    });
    if (existing) {
      res.status(400).json({ success: false, message: 'Artıq təklif vermişsiniz' });
      return;
    }

    const offer = await prisma.inquiryOffer.create({
      data: {
        inquiryId,
        sellerId: req.adminId!,
        price: parseFloat(price),
        message: message || null,
        listingId: listingId ? parseInt(listingId) : null,
      },
      include: {
        seller: { select: { id: true, name: true, phone: true, type: true } },
      },
    });

    res.status(201).json({ success: true, offer });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Accept offer (buyer)
router.put('/inquiries/:id/offers/:offerId/accept', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const inquiryId = parseInt(req.params.id);
    const offerId = parseInt(req.params.offerId);

    const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId } });
    if (!inquiry || inquiry.buyerId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    if (inquiry.status !== 'OPEN') {
      res.status(400).json({ success: false, message: 'Bu sorğu artıq bağlanıb' });
      return;
    }

    const offer = await prisma.inquiryOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.inquiryId !== inquiryId || offer.status !== 'PENDING') {
      res.status(400).json({ success: false, message: 'Təklif tapılmadı və ya artıq cavablandırılıb' });
      return;
    }

    // Kabul edilen teklifi guncelle
    await prisma.inquiryOffer.update({
      where: { id: offerId },
      data: { status: 'ACCEPTED' },
    });

    // Diger teklifleri reddet
    await prisma.inquiryOffer.updateMany({
      where: { inquiryId, id: { not: offerId }, status: 'PENDING' },
      data: { status: 'REJECTED' },
    });

    // Sorguyu kapat
    const updated = await prisma.inquiry.update({
      where: { id: inquiryId },
      data: { status: 'ACCEPTED' },
      include: {
        offers: {
          where: { id: offerId },
          include: { seller: { select: { id: true, name: true, phone: true } } },
        },
      },
    });

    res.json({ success: true, inquiry: updated, acceptedOffer: updated.offers[0] });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Close inquiry (buyer)
router.put('/inquiries/:id/close', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const inquiryId = parseInt(req.params.id);
    const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId } });
    if (!inquiry || inquiry.buyerId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    if (inquiry.status !== 'OPEN') {
      res.status(400).json({ success: false, message: 'Bu sorğu artıq bağlanıb' });
      return;
    }

    await prisma.inquiryOffer.updateMany({
      where: { inquiryId, status: 'PENDING' },
      data: { status: 'REJECTED' },
    });

    const updated = await prisma.inquiry.update({
      where: { id: inquiryId },
      data: { status: 'CLOSED' },
    });

    res.json({ success: true, inquiry: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Withdraw offer (seller)
router.put('/inquiries/offers/:offerId/withdraw', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const offerId = parseInt(req.params.offerId);
    const offer = await prisma.inquiryOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.sellerId !== req.adminId) {
      res.status(403).json({ success: false, message: 'İcazə yoxdur' });
      return;
    }
    if (offer.status !== 'PENDING') {
      res.status(400).json({ success: false, message: 'Təklif artıq cavablandırılıb' });
      return;
    }

    const updated = await prisma.inquiryOffer.update({
      where: { id: offerId },
      data: { status: 'WITHDRAWN' },
    });

    res.json({ success: true, offer: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Unread inquiry count (seller)
router.get('/inquiries/unread-count', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const count = await prisma.inquiryTarget.count({
      where: { sellerId: req.adminId!, seen: false },
    });
    res.json({ count });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
