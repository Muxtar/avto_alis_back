import { Router, Response } from 'express';
import { getInstallmentConfig, ALL_INSTALLMENT_MONTHS } from '../services/installment';

const router = Router();

// Hissəli ödəniş ayarları (hamıya açıq) — kalkulyator, səbət və elan forması üçün.
router.get('/installment/config', async (_req, res: Response) => {
  try {
    const c = await getInstallmentConfig();
    res.json({
      success: true, available: c.available, reason: c.reason, minAmount: c.minAmount, buyerPaysFee: c.buyerPaysFee,
      months: c.months, plans: c.months.map((m) => ({ months: m, feePercent: c.fees[m] || 0 })), allMonths: ALL_INSTALLMENT_MONTHS,
    });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
