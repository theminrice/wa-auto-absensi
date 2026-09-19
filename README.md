# wa-auto-absensi

Bot otomatis **Check In / Check Out WhatsApp** berbasis GitHub Actions, WhatsApp Web, MongoDB Atlas, dan RemoteAuth V3.

Project ini sudah memiliki jalur **Testing** dan **Production** yang dipisahkan dengan guard ketat.

## Status Saat Ini

**Production V3 aktif.**

- Production group: `Aktif Tim Magang OCN`
- Input-only group: `Palelu` (pesan akun sendiri saja)
- Testing group: `Testing`
- WhatsApp session: **RemoteAuth V3**
- Session persistence: **MongoDB Atlas**
- Production runner: **GitHub Actions**
- Scheduler: **Cloudflare Worker**
- Check In Testing end-to-end: ✅
- Check Out Testing + foto + caption end-to-end: ✅
- WhatsApp server ACK: ✅
- RemoteAuth V3 restore tanpa QR: ✅
- ACTIVE + LAST_GOOD session: ✅
- Temporary MongoDB Atlas runner IP lifecycle: ✅
- Production target guard: ✅
- Hardcoded group ID: ❌
- RemoteAuth V2 import pada sender production: ❌

> Catatan: fix shutdown queue RemoteAuth V3 terbaru sudah lulus CI. Runtime production berikutnya menjadi proof alami terakhir untuk patch tersebut tanpa membuat pesan test tambahan ke grup utama.

## Arsitektur

```text
Cloudflare Worker
        |
        | trigger sesuai jadwal
        v
GitHub Actions
        |
        +--> Temporary MongoDB Atlas runner IP
        |
        +--> Restore RemoteAuth V3
        |
        +--> Sync input dari grup Palelu (fromMe + exact group ID)
        |      |
        |      +--> p: <project>
        |      |
        |      +--> image + caption "p"
        |
        +--> Check In / Check Out sender
        |
        +--> Exact-name group validation
        |
        +--> WhatsApp send
        |
        +--> Server ACK verification
        |
        +--> RemoteAuth V3 save + shutdown drain
        |
        +--> Atlas runner IP cleanup
```

## Jadwal Production

Scheduler production berada di Cloudflare Worker.

Waktu operasional:

| Action | Waktu |
|---|---|
| Check In | 06:00 WIB, Senin-Sabtu |
| Check Out | 17:00 WIB, Senin-Sabtu |
| Minggu | Tidak ada absensi otomatis |

Workflow production GitHub:

```text
.github/workflows/wa-attendance-production-v1.yml
```

Workflow tersebut juga dapat dijalankan manual dengan `workflow_dispatch`.

Manual production run membutuhkan:

```text
action  = checkin / checkout
confirm = Production
```

## Target WhatsApp

### Production

```text
Aktif Tim Magang OCN
```

Sender production melakukan pencarian berdasarkan **exact group name**.

Group ID WhatsApp tidak di-hardcode.

### Testing

```text
Testing
```

Testing digunakan untuk proof end-to-end tanpa mengirim pesan ke grup production.

### Sumber Input — Palelu

```text
Palelu
```

Hanya grup bernama **persis `Palelu`** yang diterima sebagai sumber input. Sistem mencari tepat satu grup dengan nama tersebut, memeriksa ID grup WhatsApp (`@g.us`), lalu menerima **hanya pesan yang dikirim oleh akun WhatsApp bot sendiri** (`fromMe=true`). Pesan anggota lain, chat diri sendiri, dan pesan grup tujuan diabaikan. Jika grup tidak ditemukan, namanya berubah, atau ada nama grup duplikat, sync berhenti aman sebelum Check In/Check Out.

Perintah yang dikirim ke `Palelu`:

- `p:Melanjutkan audit backend` → Project.
- `l:19/9` atau `l:19/9-21/9` → jadwal libur.
- Foto dengan caption persis `p` → dokumentasi.

**Migrasi data:** Project, dokumentasi, dan rentang libur yang sudah tersimpan sebelumnya di MongoDB tidak dihapus oleh pergantian grup. Kirim Project dan foto terbaru ke `Palelu` sebelum absensi berikutnya apabila ingin mengganti data lama. Input *baru* dari self-chat tidak lagi dibaca. Jangan kirim pesan test ke grup utama `Aktif Tim Magang OCN` hanya untuk verifikasi sumber input.

## Format Input dari Grup Palelu

### Project

Project dibaca dari pesan:

```text
p: Melanjutkan audit sekuritas backend
```

Format parser:

```text
p: <project>
```

Prefix `p:` bersifat case-insensitive.

Contoh valid:

```text
p: Melanjutkan audit sekuritas backend
P: Membuat dokumentasi sistem
```

### Dokumentasi / Foto

Dokumentasi dibaca dari:

```text
image
caption: p
```

Syarat:

- pesan berasal dari akun WhatsApp sendiri di grup `Palelu` (ID grup diverifikasi),
- `hasMedia = true`,
- media type = `image`,
- caption exact = `p`.

## Perintah Libur — `l:`

Perintah libur dikirim lewat **grup `Palelu` oleh akun sendiri**. `p:x` **tidak digunakan untuk libur**; satu-satunya perintah libur adalah `l:`.

| Pesan | Arti |
|---|---|
| `l:19/9` | Libur 19 September |
| `l:19/9-21/9` | Libur 19 sampai 21 September, **inklusif** |
| `l:30/9-2/10` | Libur 30 September sampai 2 Oktober |
| `l:30/12-2/1` | Lintas tahun: 30 Desember sampai 2 Januari tahun berikutnya |
| `l:19/9/2026` | Tahun eksplisit (opsional) |

- Tanpa tahun, sistem memakai **tahun saat pesan dikirim dalam zona Asia/Jakarta**, bukan tahun ketika catch-up berjalan.
- Perintah `l:` **terbaru menggantikan rentang libur sebelumnya**; bukan menambahkan daftar rentang.
- Di dalam rentang libur, **Check In dan Check Out sama-sama SAFE SKIP**: tidak ada pesan dikirim ke grup.
- Hari di luar rentang kembali mengikuti jadwal otomatis.
- Project `p:` dan dokumentasi gambar-caption `p` **tidak dihapus atau diganti** oleh `l:`.
- Tanggal tidak valid seperti `l:31/2` atau rentang terbalik ditolak; sync production gagal aman alih-alih menganggapnya tidak ada libur.
- Kirim perintah `l:` sebelum jadwal absensi; perintah yang baru masuk setelah send tidak menarik kembali pesan yang sudah dikirim.

Marker saat jadwal jatuh pada tanggal libur:

```text
LEAVE_TODAY=YES
ATTENDANCE_LEAVE_SKIP=YES
REASON=LEAVE_DATE
ACTION=SKIP
MESSAGE_SENT=NO
ATTENDANCE_RESULT=LEAVE_SKIP
PRODUCTION_CLOUD_ATTENDANCE=PASS
```

**Status fitur:** source dan unit test ada; real grup `Palelu` `l:` dan natural production leave-skip baru dinyatakan terverifikasi setelah run yang relevan lulus. Jangan mengirim dummy attendance ke grup utama demi pengujian.

## Aturan Membersihkan Ruangan

- Senin: ✅
- Kamis: ✅
- Selasa: ❌
- Rabu: ❌
- Jumat: ❌
- Sabtu: ❌

## Format Check In

Contoh:

```text
Check In, Kamis 17 September 2026

- 08.00 : Sampai Kantor✅
- 08.10 : Membersihkan Ruangan✅
- 08.30 : Melanjutkan audit sekuritas backend
```

Pada hari tanpa jadwal membersihkan ruangan, baris tersebut tidak digunakan sesuai logic attendance.

## Format Check Out

Contoh:

```text
Check Out, Kamis 17 September 2026

- 08.00 : Sampai Kantor✅
- 08.10 : Membersihkan Ruangan✅
- 08.30 : Melanjutkan audit sekuritas backend✅
- 15.55 : Merapikan Dan Membersihkan Ruangan✅
- 16.00 : Pulang✅
```

Check Out mengirim dokumentasi/foto dengan caption attendance melalui jalur UI WhatsApp Web yang diverifikasi sebelum klik Send.

## RemoteAuth V3

RemoteAuth V3 dirancang agar session WhatsApp tetap dapat dipakai pada GitHub runner baru.

Identifier utama:

```text
Client ID:
wa-auto-absensi-remote-v3

ACTIVE:
RemoteAuth-wa-auto-absensi-remote-v3

CANDIDATE:
RemoteAuth-wa-auto-absensi-remote-v3-candidate

LAST_GOOD:
RemoteAuth-wa-auto-absensi-remote-v3-last-good
```

### Save Pipeline

```text
local active candidate
        |
        v
ZIP validation
        |
        v
save candidate
        |
        v
candidate roundtrip validation
        |
        v
preserve current ACTIVE -> LAST_GOOD
        |
        v
promote candidate -> ACTIVE
        |
        v
ACTIVE roundtrip validation
        |
        v
candidate cleanup
```

ZIP validation memeriksa antara lain:

- file tersedia,
- ukuran minimum,
- seluruh ZIP dapat dibaca/inflate,
- jumlah entry,
- total inflated bytes,
- SHA-256.

### Restore

Urutan restore:

```text
ACTIVE
  |
  +--> valid -> continue
  |
  +--> invalid
          |
          v
       LAST_GOOD
          |
          +--> valid -> fallback + best-effort self-heal ACTIVE
```

Tidak ada retry loop tanpa batas.

### Shutdown Drain

Sebelum client WhatsApp dihancurkan:

```text
shutdownStarted = true
        |
        v
tolak save baru
        |
        v
skip save lama yang masih antre
        |
        v
tunggu save queue aktif selesai
        |
        v
client.destroy()
```

Marker penting:

```text
REMOTE_V3_SHUTDOWN_STARTED=YES
REMOTE_V3_SAVE_SKIPPED_SHUTDOWN=YES
REMOTE_V3_PREQUEUED_SAVE_SKIPPED_SHUTDOWN=YES
REMOTE_V3_SAVE_QUEUE_DRAINED=YES
REMOTE_V3_SHUTDOWN_DRAIN=PASS
```

## MongoDB Atlas

MongoDB digunakan untuk:

- persistent RemoteAuth V3,
- attendance input state,
- dokumentasi attendance.

GitHub runner menggunakan temporary Atlas access-list entry.

Lifecycle:

```text
runner public IPv4
        |
        v
Atlas temporary IP add
        |
        v
wait ACTIVE
        |
        v
run attendance
        |
        v
delete temporary IP
        |
        v
verify 404
```

Secret tidak ditulis ke repository.

## Production Safety Guards

Production sender memiliki guard berikut:

- target exact `Aktif Tim Magang OCN`,
- menolak reference ke group `Testing`,
- tidak memakai hardcoded `@g.us` ID,
- wajib menggunakan RemoteAuth V3,
- QR pada cloud run dianggap error,
- MongoDB session harus tersedia,
- WhatsApp harus mencapai READY,
- target harus benar-benar group,
- server ACK harus terkonfirmasi,
- RemoteAuth save queue harus drain sebelum shutdown.

## Proof / Testing Workflows

### Production V3 Readiness

```text
.github/workflows/wa-production-v3-readiness.yml
```

Tidak mengirim WhatsApp message.

Membuktikan:

- fresh runner,
- RemoteAuth V3 restore,
- no QR,
- WhatsApp READY,
- sinkronisasi input grup `Palelu` (tanpa mengirim pesan).

### Full Proof ke Testing

```text
.github/workflows/wa-production-v3-all-proof-testing.yml
```

Mengirim:

```text
1x Check In  -> Testing
1x Check Out -> Testing + media/caption
```

Main production group dilarang pada proof ini.

### Checkout E2E Proof

```text
.github/workflows/wa-production-v3-e2e-proof-testing.yml
```

Manual-only dan hanya menargetkan `Testing`.

### Legacy Live Self-Chat Input Proof (tidak relevan untuk sumber aktif)

```text
.github/workflows/wa-production-v3-live-self-chat-input-proof.yml
```

Workflow lama menguji self-chat saja dan **tidak lagi membuktikan jalur input aktif `Palelu`**. Jangan menggunakannya untuk memverifikasi migrasi input grup.

## Hasil Proof Terbaru

Terakhir diverifikasi pada **19 September 2026**.

### Check In -> Testing

```text
TARGET_GROUP_NAME=Testing
TARGET_GROUP_SAFE=YES
SERVER_ACK_CONFIRMED=YES
MESSAGE_SENT=YES
E2E_PROOF_CHECKIN=PASS
```

Status: **PASS**

### Check Out -> Testing

```text
TARGET_GROUP_NAME=Testing
TARGET_GROUP_SAFE=YES

UI_PHOTO_VIDEO_PATH_CONFIRMED=YES
UI_REAL_MEDIA_CAPTION_BOX_CONFIRMED=YES
UI_FINAL_CAPTION_EXACT=YES
UI_PHOTO_SEND_BUTTON_CLICKED=YES

SERVER_ACK_CONFIRMED=YES
MESSAGE_SENT=YES
MEDIA_SENT=YES
CAPTION_SENT=YES

E2E_PROOF=PASS
```

Status: **PASS**

### Production Group

Jalur production menggunakan source V3 yang sama, tetapi targetnya:

```text
Aktif Tim Magang OCN
```

Real production send setelah patch shutdown queue terbaru belum dijadikan test tambahan secara sengaja untuk menghindari pesan duplikat. Verifikasi berikutnya dilakukan pada run production yang memang terjadwal.

## NPM Scripts

Script utama:

```bash
npm test

npm run attendance:sync-once-production-v3

npm run wa:send-checkin-production
npm run wa:send-checkout-production

npm run wa:remoteauth-v3-bootstrap
npm run wa:remoteauth-v3-health

npm run wa:send-checkin-v3-proof-testing
npm run wa:send-checkout-v3-proof-testing

npm run wa:input-parser-v3-proof
npm run wa:live-self-chat-input-proof-v3
```

## Environment / Secrets

Production membutuhkan secret seperti:

```text
MONGODB_URI

ATLAS_CLIENT_ID
ATLAS_CLIENT_SECRET
ATLAS_PROJECT_ID
```

Jangan commit secret, QR session, MongoDB URI, token, password, atau credential lain ke repository.

## Menjalankan Production Secara Manual

Buka:

```text
GitHub
-> Actions
-> WA Attendance Production V1
-> Run workflow
```

Pilih:

```text
action:
  checkin
atau
  checkout

confirm:
  Production
```

Gunakan manual production run hanya jika memang ingin mengirim attendance ke grup utama.

## Menjalankan Test Aman

Untuk proof tanpa menyentuh grup utama, gunakan workflow yang menargetkan `Testing`.

Sebelum rerun test yang benar-benar mengirim WhatsApp, periksa apakah run sebelumnya sudah mengirim pesan agar tidak membuat duplikat.

## CI

Workflow:

```text
.github/workflows/wa-ci.yml
```

CI memeriksa antara lain:

- project tests,
- dependency load,
- syntax seluruh source WhatsApp,
- RemoteAuth V3 no-send guards,
- production V3 cutover guards,
- Testing E2E guards,
- full-proof guards,
- `p:` / `p + image` parser proof,
- live self-chat proof guards,
- RemoteAuth V3 shutdown-drain guards.

## Prinsip Safety Project

Project ini menggunakan prinsip:

```text
verify first
send once
no blind retry
exact target
server ACK
persistent session
safe shutdown
cleanup temporary access
```

Jika hasil send ambigu, jangan langsung rerun. Audit log terlebih dahulu untuk memastikan pesan belum terkirim.

## Tech Stack

- Node.js
- JavaScript / CommonJS
- GitHub Actions
- Cloudflare Workers
- MongoDB Atlas
- Mongoose
- whatsapp-web.js
- wwebjs-mongo
- Puppeteer / Chrome
- unzipper

## Current Production State

```text
Production target:
Aktif Tim Magang OCN

RemoteAuth:
V3

Testing Check In:
PASS

Testing Check Out:
PASS

Testing media + caption:
PASS

Server ACK:
PASS

Production source guards:
PASS

Latest CI:
PASS
```
