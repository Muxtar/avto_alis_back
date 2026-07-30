// AI Köməkçi endpoint-i — istifadəçi təbii dildə saytın xüsusiyyətlərini işlədir.
// adminAuth cari istifadəçini təyin edir (req.adminId); agent yalnız onun kimliyi ilə işləyir.
import { Router, Response } from 'express';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { aiChatLimiter } from '../middleware/rateLimiter';
import { runAgent, aiAgentEnabled, ChatTurn } from '../services/aiAgent';

const router = Router();

// Söhbət — {messages:[{role,content}]} qəbul edir, {reply, pendingAction} qaytarır.
// pendingAction varsa (məs. mesaj göndər), frontend onu təsdiq üçün göstərir.
router.post('/ai/chat', aiChatLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!aiAgentEnabled()) {
      res.status(503).json({ success: false, message: 'AI köməkçi hazırda əlçatan deyil' });
      return;
    }
    const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
    // Yalnız son 20 mətn növbəsi — token/xərc nəzarəti.
    const history: ChatTurn[] = raw
      .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string')
      .slice(-20)
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
    if (!history.length || history[history.length - 1].role !== 'user') {
      res.status(400).json({ success: false, message: 'Mesaj tələb olunur' });
      return;
    }
    const { reply, pendingAction } = await runAgent(req.adminId!, history);
    res.json({ success: true, reply, pendingAction });
  } catch (error: any) {
    console.error('[POST /ai/chat] error:', error?.message || error);
    res.status(500).json({ success: false, message: 'AI cavab verə bilmədi' });
  }
});

export default router;
