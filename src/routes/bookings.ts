import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';

const router = Router();
const prisma = new PrismaClient();

// Bron yaratma — spam qoruması: 20 sorğu / saat
const bookingLimiter = rateLimit(20, 60 * 60 * 1000);

// İki tarix aralığı üst-üstə düşürmü? [aIn, aOut) və [bIn, bOut)
function overlaps(aIn: Date, aOut: Date, bIn: Date, bOut: Date): boolean {
  return aIn < bOut && bIn < aOut;
}

function parseDay(v: any): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

const bookingInclude = {
  listing: { select: { id: true, title: true, images: true, location: true, city: true, price: true, bookingType: true } },
  guest: { select: { id: true, name: true, avatar: true } },
  host: { select: { id: true, name: true, avatar: true } },
};

// ── Qonaq: bron sorğusu yarat ────────────────────────────────────────────────
router.post('/bookings', bookingLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const listingId = parseInt(String(req.body.listingId));
    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      select: { id: true, userId: true, title: true, bookable: true, bookingType: true, price: true, maxGuests: true },
    });
    if (!listing) { res.status(404).json({ success: false, message: 'Elan tapılmadı' }); return; }
    if (!listing.bookable || !listing.bookingType) { res.status(400).json({ success: false, message: 'Bu elan bron üçün açıq deyil' }); return; }
    if (listing.userId === req.adminId) { res.status(400).json({ success: false, message: 'Öz elanınızı bron edə bilməzsiniz' }); return; }

    const type = listing.bookingType;
    const guests = Math.max(1, parseInt(String(req.body.guests)) || 1);
    const contactPhone = String(req.body.contactPhone || '').trim();
    const contactName = req.body.contactName ? String(req.body.contactName).trim().slice(0, 80) : null;
    const note = req.body.note ? String(req.body.note).trim().slice(0, 500) : null;
    if (!contactPhone) { res.status(400).json({ success: false, message: 'Əlaqə nömrəsi tələb olunur' }); return; }
    if (listing.maxGuests && guests > listing.maxGuests) {
      res.status(400).json({ success: false, message: `Maksimum ${listing.maxGuests} nəfər üçün bron mümkündür` }); return;
    }

    const data: any = { listingId, guestId: req.adminId!, hostId: listing.userId, type, guests, contactPhone, contactName, note, status: 'PENDING' };

    if (type === 'RESERVATION') {
      const date = parseDay(req.body.date);
      if (!date) { res.status(400).json({ success: false, message: 'Tarix seçin' }); return; }
      data.date = date;
      data.time = req.body.time ? String(req.body.time).trim().slice(0, 10) : null;
      data.totalPrice = listing.price ? listing.price * guests : null;
    } else {
      // STAY
      const checkIn = parseDay(req.body.checkIn);
      const checkOut = parseDay(req.body.checkOut);
      if (!checkIn || !checkOut) { res.status(400).json({ success: false, message: 'Giriş və çıxış tarixini seçin' }); return; }
      if (checkOut <= checkIn) { res.status(400).json({ success: false, message: 'Çıxış tarixi girişdən sonra olmalıdır' }); return; }
      const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / (24 * 60 * 60 * 1000));
      const rooms = req.body.rooms ? Math.max(1, parseInt(String(req.body.rooms))) : null;

      // Təsdiqlənmiş bronlarla üst-üstə düşmə yoxlaması.
      const confirmed = await prisma.booking.findMany({
        where: { listingId, status: 'CONFIRMED', type: 'STAY', checkIn: { not: null }, checkOut: { not: null } },
        select: { checkIn: true, checkOut: true },
      });
      const clash = confirmed.some((b) => b.checkIn && b.checkOut && overlaps(checkIn, checkOut, b.checkIn, b.checkOut));
      if (clash) { res.status(409).json({ success: false, message: 'Seçilmiş tarixlərdə artıq bron var. Başqa tarix seçin.' }); return; }

      data.checkIn = checkIn;
      data.checkOut = checkOut;
      data.nights = nights;
      data.rooms = rooms;
      data.totalPrice = listing.price ? listing.price * nights * (rooms || 1) : null;
    }

    const booking = await prisma.booking.create({ data, include: bookingInclude });
    await prisma.notification.create({
      data: { userId: listing.userId, type: 'BOOKING', title: 'Yeni bron sorğusu', body: `«${listing.title}» üçün yeni bron sorğusu gəldi.`, link: '/bookings' },
    }).catch(() => {});

    res.json({ success: true, booking });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Mənim bronlarım (qonaq + sahib) ──────────────────────────────────────────
router.get('/me/bookings', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const [asGuest, asHost] = await Promise.all([
      prisma.booking.findMany({ where: { guestId: req.adminId! }, orderBy: { createdAt: 'desc' }, include: bookingInclude }),
      prisma.booking.findMany({ where: { hostId: req.adminId! }, orderBy: { createdAt: 'desc' }, include: bookingInclude }),
    ]);
    res.json({ success: true, asGuest, asHost });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Status dəyişmə (sahib təsdiq/rədd; qonaq ləğv) ────────────────────────────
const HOST_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['CONFIRMED', 'REJECTED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED'],
};
router.put('/bookings/:id/status', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const next = String(req.body.status || '').toUpperCase();
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) { res.status(404).json({ success: false, message: 'Bron tapılmadı' }); return; }

    const isHost = booking.hostId === req.adminId;
    const isGuest = booking.guestId === req.adminId;
    if (!isHost && !isGuest) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }

    // Qonaq yalnız ləğv edə bilər (PENDING və ya CONFIRMED ikən).
    if (isGuest && !isHost) {
      if (next !== 'CANCELLED' || !['PENDING', 'CONFIRMED'].includes(booking.status)) {
        res.status(400).json({ success: false, message: 'Bu əməliyyat mümkün deyil' }); return;
      }
    } else {
      // Sahib keçidləri
      const allowed = HOST_TRANSITIONS[booking.status] || [];
      if (!allowed.includes(next)) { res.status(400).json({ success: false, message: `${booking.status} → ${next} keçidi mümkün deyil` }); return; }
      // Təsdiq zamanı GECƏLƏMƏ üçün təkrar üst-üstə düşmə yoxlaması.
      if (next === 'CONFIRMED' && booking.type === 'STAY' && booking.checkIn && booking.checkOut) {
        const confirmed = await prisma.booking.findMany({
          where: { listingId: booking.listingId, status: 'CONFIRMED', type: 'STAY', id: { not: booking.id }, checkIn: { not: null }, checkOut: { not: null } },
          select: { checkIn: true, checkOut: true },
        });
        const clash = confirmed.some((b) => b.checkIn && b.checkOut && overlaps(booking.checkIn!, booking.checkOut!, b.checkIn, b.checkOut));
        if (clash) { res.status(409).json({ success: false, message: 'Bu tarixlərdə artıq təsdiqlənmiş bron var' }); return; }
      }
    }

    const updated = await prisma.booking.update({ where: { id }, data: { status: next as any }, include: bookingInclude });

    // Qarşı tərəfə bildiriş.
    const labels: Record<string, string> = { CONFIRMED: 'təsdiqləndi', REJECTED: 'rədd edildi', CANCELLED: 'ləğv edildi', COMPLETED: 'tamamlandı' };
    const notifyUserId = isHost ? booking.guestId : booking.hostId;
    if (labels[next]) {
      await prisma.notification.create({
        data: { userId: notifyUserId, type: 'BOOKING', title: 'Bron statusu', body: `«${updated.listing.title}» bronu ${labels[next]}.`, link: '/bookings' },
      }).catch(() => {});
    }

    res.json({ success: true, booking: updated });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

// ── Mövcudluq: təsdiqlənmiş gecələmə aralıqları (təqvimi bağlamaq üçün) ────────
router.get('/listings/:id/booking-availability', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const confirmed = await prisma.booking.findMany({
      where: { listingId: id, status: 'CONFIRMED', type: 'STAY', checkIn: { not: null }, checkOut: { not: null } },
      select: { checkIn: true, checkOut: true },
      orderBy: { checkIn: 'asc' },
    });
    res.json({ success: true, blocked: confirmed });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
