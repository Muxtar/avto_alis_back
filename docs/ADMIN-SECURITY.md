# Admin panelinin təhlükəsizliyi

Admin panelinə giriş **yalnız telefon nömrəsi + SMS təsdiq kodu** ilədir.
İsim + şifrə girişi tamamilə bağlanıb (`POST /admin/login` → 410).

## 1. Railway env dəyişənləri

İki ayrı siyahı var və fərqi vacibdir:

| Dəyişən | Nə verir |
|---|---|
| `ADMIN_PHONES` | **Super-admin.** Hər modula icazəli. Panel üzərindən səlahiyyəti götürülə bilməz. Hesab yoxdursa ilk girişdə avtomatik yaradılır. |
| `ADMIN_LOGIN_PHONES` | **Yalnız giriş icazəsi.** Bu nömrənin sahibi əvvəlcədən panel üzərindən admin kimi əlavə edilməli və icazələri təyin edilməlidir. Sadəcə env-ə yazmaqla səlahiyyət ALMIR. |

Format — vergüllə ayrılmış, boşluqsuz:

```
ADMIN_PHONES=+994501234567,+994551234567
ADMIN_LOGIN_PHONES=+994701234567
```

Nömrələr **son 9 rəqəm** üzrə tutuşdurulur, ona görə `+994`, `0` prefiksi və
boşluq fərqi problem yaratmır.

> **Diqqət:** `ADMIN_PHONES` boş qalsa heç kim panelə girə bilməz.
> Dəyişəni silmədən əvvəl özünüzün nömrəsinin siyahıda olduğuna əmin olun.

### Məhdud icazəli admin necə əlavə olunur

1. Həmin şəxs saytda adi istifadəçi kimi qeydiyyatdan keçir.
2. Super-admin → Admin panel → **Adminlər** → onu admin kimi əlavə edir və
   modul icazələrini seçir.
3. Onun nömrəsi `ADMIN_LOGIN_PHONES`-a yazılır.
4. Artıq nömrə + kod ilə girə bilər, yalnız verilən modulları görər.

## 2. Hesab kilidlənməsi

Ardıcıl **5** səhv təsdiq kodundan sonra hesab **30 dəqiqə** kilidlənir.

Bu, IP limitindən (`dəqiqədə 5 sorğu`) asılı deyil — fərqli IP-lərdən aparılan
yavaş hücum da dayanır. Uğurlu girişdə sayğac sıfırlanır.

Kilid `User.adminLockedUntil` sahəsindədir; təcili hallarda bazadan
`adminLockedUntil = NULL` etməklə açıla bilər.

> Nəzərə alın: kimsə sizin nömrənizə qəsdən səhv kod göndərərək hesabı 30 dəqiqə
> kilidləyə bilər. Bu, standart kompromisdir — parol sındırmanın qarşısını alır.

## 3. `noindex`

`/admin/*` səhifələri axtarış sistemlərinə düşmür:

```
<meta name="robots" content="noindex, nofollow, nocache">
<meta name="googlebot" content="noindex, nofollow, noimageindex">
```

`robots.txt`-ə `Disallow: /admin` **qəsdən yazılmayıb** — o fayl hamıya açıqdır
və yolu elan etmiş olardı.

## 4. Cloudflare Access (kod deyil — infrastruktur)

Ən güclü qat budur: `/admin/*` ünvanına gələn sorğu **sayta çatmamışdan əvvəl**
Cloudflare tərəfindən tutulur. Kənar adam login səhifəsini ümumiyyətlə görmür.
50 istifadəçiyə qədər **pulsuzdur**.

### Qurulum

1. `tradixai.io` domenini Cloudflare-ə keçirin (nameserver dəyişikliyi).
2. **Zero Trust** → **Access** → **Applications** → **Add an application** →
   **Self-hosted**.
3. Application configuration:
   - Application name: `tradixai admin`
   - Session duration: `24 hours`
   - Public hostname: `tradixai.io`, Path: `admin`
4. **Add policy**:
   - Policy name: `Admins`
   - Action: `Allow`
   - Include → **Emails** → admin e-poçtlarını əlavə edin
5. Save.

Bundan sonra `/admin` açan hər kəs əvvəlcə Cloudflare-in e-poçt təsdiq ekranını
görür; yalnız siyahıdakılar keçib sayta çatır və orada nömrə + SMS kodu ilə
ikinci dəfə təsdiqlənir.

### Alternativ: IP allowlist

Adminlər sabit IP-dən girirsə daha sadədir:
Zero Trust → Access → policy-də `Include → IP ranges`.
Mobil internetdə IP dəyişdiyi üçün gündəlik işə mane ola bilər.

## 5. Nə üçün ünvanı gizlətmirik

`/admin` yolunu təsadüfi bir şeyə dəyişmək **real müdafiə vermir**: Next.js
marşrutları client bundle-ında olduğu üçün brauzerin JS fayllarına baxan
istənilən adam yeni yolu bir neçə saniyəyə tapır. Bunun əvəzinə girişin özü
gücləndirilib (tək faktor yoxdur, env siyahısı, kilidləmə) və qarşısına
Cloudflare Access qoyulması tövsiyə olunur.
