// PEŞƏ QRUPLARI marşrutları. Məntiq: services/proGroups.ts.
import { Router, Response } from 'express';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { proGroupsOverview, joinProGroup, leaveProGroup, keepProGroup } from '../services/proGroups';

const router = Router();

router.get('/me/pro-groups', adminAuth, async (req: AuthRequest, res: Response) => {
  try { res.json({ success: true, ...(await proGroupsOverview(req.adminId!)) }); }
  catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/me/pro-groups/join', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const g = await joinProGroup(req.adminId!, String(req.body?.profession || ''));
    res.json({ success: true, group: { id: g.id, name: g.name } });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/me/pro-groups/:id/leave', adminAuth, async (req: AuthRequest, res: Response) => {
  try { await leaveProGroup(req.adminId!, parseInt(String(req.params.id))); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

router.post('/me/pro-groups/:id/keep', adminAuth, async (req: AuthRequest, res: Response) => {
  try { await keepProGroup(req.adminId!, parseInt(String(req.params.id))); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
