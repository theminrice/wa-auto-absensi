# wa-auto-absensi

Tahap awal bot Auto Check In / Check Out WhatsApp.

## Status V1

V1 ini **belum mengirim WhatsApp**. Tujuannya memverifikasi format absensi dan aturan hari secara aman di GitHub Actions.

Target sementara:

- Grup: `Testing`
- Production: `false`
- WhatsApp send: `disabled`

## Aturan Membersihkan Ruangan

- Senin: ✅
- Kamis: ✅
- Selasa/Rabu/Jumat: ❌

## Format project

Project dibaca dari format:

```text
p:Melanjutkan audit sekuritas backend
```

## Check In

```text
Check In, Kamis 17 September 2026

- 08.00 : Sampai Kantor✅
- 08.10 : Membersihkan Ruangan✅
- 08.30 : Melanjutkan audit sekuritas backend
```

## Check Out

```text
Check Out, Kamis 17 September 2026

- 08.00 : Sampai Kantor✅
- 08.10 : Membersihkan Ruangan✅
- 08.30 : Melanjutkan audit sekuritas backend✅
- 15.55 : Merapikan Dan Membersihkan Ruangan✅
- 16.00 : Pulang✅
```

## Test GitHub Actions

Buka:

`Actions` → `WA Auto Absensi - Safe Test` → `Run workflow`

Pilih:

- `dry-run`
- `checkin`
- `checkout`

Pada V1 semuanya hanya mencetak hasil ke log dan **tidak mengirim pesan WhatsApp**.

## Tahap berikutnya

Setelah format V1 lulus, baru tambahkan:

1. login WhatsApp Web,
2. baca chat diri sendiri,
3. cari `p:` terbaru,
4. cari gambar dokumentasi caption `p`,
5. kirim hanya ke grup `Testing`,
6. anti-double-send,
7. persistent session,
8. scheduler.
