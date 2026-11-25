# Walkthrough Peningkatan Bubu AI (`bubu-whatsapp-agent`)

Implementasi peningkatan berdasarkan hasil audit SQLite (`data/bubu.sqlite`), log PM2 (`bubu`), dan perilaku WAHA GOWS telah selesai dilakukan dalam 4 tahap (Stage A–D) serta terverifikasi seluruhnya.

---

## Ringkasan Perubahan per Tahap

### Stage A — Media MIME, Stiker, Quote Media, & Dead-Letter
- **Kompatibilitas MIME WAHA (`.mp4` & `.webm`)**:
  - [media-validator.js](file:///opt/apps/bubu-ai/src/media/media-validator.js): Menambahkan `'application/mp4'` ke `EXTENSION_MIMES['.mp4']` dan `extensionFromMime()`, serta menambahkan helper `isAnimatedWebpBuffer(buffer)` untuk mendeteksi frame/flag animasi WebP (`ANIM`, `ANMF`, dan bit animasi `VP8X`).
  - [media-http.js](file:///opt/apps/bubu-ai/src/utils/media-http.js): Memperbarui `validateResponseMime` agar mengizinkan alias container yang cocok pada ekstensi yang sama (misalnya `video/mp4` vs `application/mp4`, serta `video/webm` untuk `.webm`), sekaligus menyertakan `declaredMime`, `responseMime`, dan `mediaLabel` pada `UserValidationError`.
  - [media-service.js](file:///opt/apps/bubu-ai/src/media/media-service.js): Menambahkan logging detail saat validasi MIME respons gagal pada `download()`, dan menggagalkan `processImage()` lebih awal dengan `UserValidationError` (non-retryable) ketika buffer terdeteksi sebagai WebP animasi sebelum memanggil `ffmpeg`/`tesseract`.
- **Deteksi Stiker, `PushName`, & Quote Media**:
  - [normalizer.js](file:///opt/apps/bubu-ai/src/channels/waha/normalizer.js): Mengekstrak `pushName`, `isSticker`, dan `isAnimatedSticker`; memperbarui `extractQuoteContext` untuk mendeteksi `quoted.stickerMessage` serta mempertahankan metadata `replyTo.media` (`url`, `mimetype`, `filename`, `isPtt`, `durationSeconds`, `isSticker`) meskipun `quotedRaw` hadir, sambil memblokir URL `mmg.whatsapp.net`.
  - [message-processor.js](file:///opt/apps/bubu-ai/src/agent/message-processor.js):
    - Mengabaikan stiker di grup secara diam-diam tanpa memicu AI/media atau mencemari buffer pasif grup.
    - Membuffer stub media grup non-stiker (mis. `[Mengirim gambar: foto.jpg]`) beserta `msg.pushName` ketika `groupPassiveHistory` aktif dan pesan tidak menyebut Bubu.
    - Menangani stiker animasi di DM pribadi langsung melalui notifikasi non-retryable.
    - Menambahkan pra-muat `quoteContext.media` saat user membalas media (gambar/audio/video/dokumen) dan menurunkan fallback `quoteContext.mediaExpired = true` saat WAHA merespons `404`/`410`.
- **Dead-Letter Grup & Stiker**:
  - [index.js](file:///opt/apps/bubu-ai/src/index.js): `createDeadLetterNotifier` melewatkan stiker (`incoming.isSticker`) dan menyertakan `{ replyTo: incoming.eventId }` saat mengirim pemberitahuan kegagalan ke grup yang memiliki `incoming.eventId`.

### Stage B — Metadata Sosial Media & HTML (Tier 1)
- [web-service.js](file:///opt/apps/bubu-ai/src/web/web-service.js): Menambahkan `extractHtmlMetadata(html)` (OpenGraph, Twitter Card, meta description/author, `link rel="canonical"`, dan ringkasan JSON-LD), `resolveOEmbedUrl(inputUrl)` (khusus allowlist `tiktok.com`, `youtube.com`, `youtu.be`, `vimeo.com`), dan `fetchJsonWithSsrfGuard(...)` yang memanfaatkan guard DNS/SSRF milik `WebFetchService` (termasuk flag `allowJson` yang aman serta proteksi lone surrogate pada entitas HTML numerik). Output `[PAGE_METADATA]` disertakan pada hasil `WebFetchService.fetch()` dengan tetap menjaga kompatibilitas penuh pada situs HTML biasa.
- [web-tools.js](file:///opt/apps/bubu-ai/src/web/web-tools.js): Memperbarui deskripsi tool `web_fetch` agar mencakup ekstraksi metadata tautan media sosial publik (IG/TikTok/YouTube/X).

### Stage C — Telemetry Usage Tool, Pricing, Memori, & Prompt
- [system-tools.js](file:///opt/apps/bubu-ai/src/agent/system-tools.js) *(baru)*: Menambahkan tool `get_bubu_usage_summary` (strict `scopes: ['personal']`, `group: 'system'`, `readOnly: true`, validasi Zod) yang merangkum pemakaian token Sumopod, estimasi biaya USD/IDR, latensi per tier/model, daftar model aktif, antrean `InboxWorker`, dan kesehatan sesi WAHA tanpa pernah membaca/mengekspos secret atau API key.
- [model-pricing.js](file:///opt/apps/bubu-ai/src/utils/model-pricing.js): Menambahkan tarif `gpt-5.4-nano`, `gpt-5.4-mini`, dan `gpt-5.4` beserta pemetaannya pada `getModelRates`.
- [tool-registry.js](file:///opt/apps/bubu-ai/src/agent/tool-registry.js), [runtime.js](file:///opt/apps/bubu-ai/src/agent/runtime.js), [pipeline-events.js](file:///opt/apps/bubu-ai/src/telemetry/pipeline-events.js), [index.js](file:///opt/apps/bubu-ai/src/index.js): Mengaktifkan grup tool `'system'`, memicu grup `'web'` untuk URL media sosial serta `quoteText`, dan menghubungkan `config` + `worker.getStats` ke `registerAllTools`.
- [memory-service.js](file:///opt/apps/bubu-ai/src/memory/memory-service.js) & [message-processor.js](file:///opt/apps/bubu-ai/src/agent/message-processor.js): Memperluas `DURABLE_SIGNAL` untuk kalimat fakta personal natural (Indonesia/Inggris) tanpa memicu pertanyaan biasa, serta menutup `willCaptureMemory` dengan `!isGreetingFastPath`.
- [prompt-builder.js](file:///opt/apps/bubu-ai/src/agent/prompt-builder.js): Memperbarui `SYSTEM_PROMPT` (konsistensi register sapaan Indonesia, menghindari kebocoran nama internal tool saat obrolan biasa, kejujuran metadata tautan sosial, pengiriman dokumen langsung pada self-DM, dan penggunaan `get_bubu_usage_summary` di DM) serta konteks `[UNTRUSTED_QUOTED_MESSAGE]` untuk `mediaLoaded` dan `mediaExpired`.

### Stage D — Default Config, Fast-Path, Self-DM Delivery, Formatter, & Shutdown
- [env.js](file:///opt/apps/bubu-ai/src/config/env.js) & [.env.example](file:///opt/apps/bubu-ai/.env.example): Mengubah nilai bawaan `MODEL_FAST=deepseek-flash`, `GROUP_MEDIA_REQUIRE_MENTION=true`, dan `GROUP_PASSIVE_HISTORY=true`.
- [model-router.js](file:///opt/apps/bubu-ai/src/agent/model-router.js): Mengarahkan ucapan terima kasih dan konfirmasi singkat (`terimakasih`, `makasih ya`, `wow keren`, `oke siap`, dll.) ke jalur cepat `'greeting'`.
- [document-tools.js](file:///opt/apps/bubu-ai/src/documents/document-tools.js): Menyatukan `sendGeneratedWorkspaceFile` agar dokumen hasil `create_document` / `create_pdf` / `create_spreadsheet` pada chat DM pemilik (`ctx.chatId === ctx.requesterId`) langsung terkirim tanpa `/approve`, sambil mempertahankan alur `/approve` untuk pengiriman lintas-chat.
- [command-handler.js](file:///opt/apps/bubu-ai/src/agent/command-handler.js): Menyimpan pesan user (`/approve`/`/deny`) bersama balasan asisten ke riwayat `messages` saat persetujuan berhasil diproses.
- [whatsapp-formatter.js](file:///opt/apps/bubu-ai/src/channels/whatsapp-formatter.js): Merender tabel perbandingan Markdown >= 3 kolom sebagai judul baris bernomor dengan bullet berindentasi (mempertahankan format tabel 2 kolom lama).
- [app.js](file:///opt/apps/bubu-ai/src/app.js) & [index.js](file:///opt/apps/bubu-ai/src/index.js): Mengekspos `app.closeVisualizerStreams()` dan memanggilnya sebelum `await app.close()` saat `shutdown()` agar koneksi SSE aktif tidak membuat proses hang hingga timeout PM2 dan `db.close()` dapat menjalankan `wal_checkpoint(TRUNCATE)`.

---

## Verifikasi

Perintah yang dijalankan pada `/opt/apps/bubu-ai` setelah edit terakhir:

```bash
npm run check
```

Hasil yang diamati langsung:
- **Syntax check**: `Syntax check passed (113 JS/CJS files).`
- **Test suite (`node --test "test/**/*.test.js"`)**: **435 / 435 passed**, 0 failed, 0 skipped, 0 cancelled.
- **Test baru/diperbarui**: [system-tools.test.js](file:///opt/apps/bubu-ai/test/unit/agent/system-tools.test.js) serta pembaruan dan penambahan skenario uji di 14 berkas unit test (`config.test.js`, `document-tools.test.js`, `document-intelligence.test.js`, `media-pipeline.test.js`, `group-routing.test.js`, `message-context.test.js`, `web-fetch.test.js`, `tool-routing.test.js`, `model-pricing.test.js`, `memory-service.test.js`, `model-router.test.js`, `whatsapp-formatter.test.js`, `app-visualizer.test.js`, dan `inbox-worker.test.js`).
- File sensitif `.env`, serta direktori `data/` dan `backups/` tidak dibaca, diubah, atau dihapus. Service PM2 `bubu` belum di-restart.

---

## Tindakan Selanjutnya Sebelum Restart PM2

1. Periksa berkas `.env` produksi Anda untuk memastikan tidak ada override lama yang masih mengunci nilai sebelumnya:
   - `MODEL_FAST=deepseek-v4-pro` (hapus atau ubah ke `deepseek-flash` agar default baru aktif)
   - `GROUP_MEDIA_REQUIRE_MENTION=false` (hapus atau ubah ke `true`)
   - `GROUP_PASSIVE_HISTORY=false` (hapus atau ubah ke `true`)
2. Konfirmasi jika ingin saya jalankan `pm2 restart bubu` lalu cek `/health`, `/ready`, dan log PM2.
