// ANLIQ YENİLƏNMƏ — səhifəni yeniləmədən dəyişikliyi göstərmək üçün ortaq kanal.
//
// Problem: admin elanı / kimliyi / biznesi təsdiqləyir, istifadəçi isə bunu
// yalnız səhifəni yeniləyəndə görürdü. Bildiriş zəngi 8 saniyədən bir sorğu
// göndərirdi, açıq səhifənin öz məlumatı (elanın statusu, kimlik statusu və s.)
// isə ümumiyyətlə yenilənmirdi.
//
// Həll: vəziyyəti dəyişən hər əməliyyat BURADAN bir hadisə göndərir. Frontend
// hadisəni `kind` üzrə tutub yalnız aidiyyəti olan məlumatı yenidən çəkir
// (lib/live.ts → useLive). Hadisə məlumatın özünü daşımır — yalnız "bu növ
// dəyişdi" deyir. Beləliklə icazə yoxlaması həmişə adi API-də qalır və
// socket-dən başqasının məlumatı sızmır.
import { emitToUser, emitToAdmins, emitToAll } from './callSignaling';

// İstifadəçi tərəfində dəyişə bilən məlumat növləri.
export type LiveKind =
  | 'listing'       // elanın moderasiyası / silinməsi / arxivlənməsi
  | 'identity'      // kimlik (KYC) statusu
  | 'seller'        // satıcı ərizəsi
  | 'business'      // biznes (şirkət) təsdiqi / aktivliyi
  | 'object'        // biznes obyekti aktivliyi / silinməsi
  | 'credential'    // peşə sənədi
  | 'social'        // sosial şəbəkə linkinin təsdiqi
  | 'account'       // blok, rol, ad/telefon — profilin özü
  | 'complaint'
  | 'support'
  | 'return'
  | 'order'
  | 'payout'        // hesablaşma / ödəniş
  | 'consultation'
  | 'booking'
  | 'notification'; // yalnız bildiriş (səhifə məlumatı dəyişməyib)

export interface LivePayload {
  kind: LiveKind;
  id?: number | string;
  status?: string | null;
  // Doldurulubsa istifadəçiyə hansı səhifədə olsa da toast göstərilir.
  toast?: string;
  tone?: 'success' | 'error' | 'info';
}

/** Bir və ya bir neçə istifadəçiyə "məlumatın dəyişdi" xəbəri. */
export function pushLive(userIds: number | number[] | null | undefined, payload: LivePayload) {
  const ids = Array.isArray(userIds) ? userIds : userIds != null ? [userIds] : [];
  for (const id of new Set(ids)) {
    if (Number.isInteger(id)) emitToUser(id, 'live:update', { ...payload, at: Date.now() });
  }
}

// Admin panelində gözləyən iş növləri — yeni müraciət gələndə panel özü yenilənsin.
export type AdminLiveKind =
  | 'listing' | 'identity' | 'seller' | 'business' | 'object' | 'credential' | 'social'
  | 'complaint' | 'support' | 'return' | 'order' | 'refund';

/** Admin panelinə "yeni iş var / iş dəyişdi" xəbəri. */
export function pushAdmins(kind: AdminLiveKind, data: { id?: number | string; toast?: string } = {}) {
  emitToAdmins('admin:live', { kind, ...data, at: Date.now() });
}

/** İctimai vitrin dəyişdi (elan saytda göründü / gizləndi) — bütün açıq
    səhifələrə. Yalnız "yeni elanlar var" işarəsi üçündür: siyahı istifadəçinin
    əli altında özbaşına dəyişməsin deyə frontend onu avtomatik yükləmir. */
export function pushPublicListings(data: { id?: number; reason: 'approved' | 'removed' }) {
  emitToAll('public:listings', { ...data, at: Date.now() });
}
