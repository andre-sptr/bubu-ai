# Bubu v2.4.0 — Roadmap dan Task Phase 2

8 November 2026 · Handover & Status Audit Phase 2 (Diperbarui hingga Task 2.8)

**Phase 1 — Core Reliability & Response Control** sudah selesai dan disetujui pemilik. **Phase 2 — Full Multimodal WhatsApp** aktif; seluruh patch kode dan regresi unit lokal untuk **Task 2.1 hingga Task 2.8** telah diimplementasikan dan diverifikasi (203/203 tes unit terfokus lulus), tinggal menunggu eksekusi `npm run test:phase1` / `bash scripts/phase2-regression.sh` dan matriks acceptance WhatsApp langsung di VPS oleh pemilik. Phase 3–6 masih tersisa.

## Mulai di sesi baru

Gunakan prompt berikut bila melanjutkan verifikasi VPS dan acceptance WhatsApp Phase 2:

> Bertindak sebagai Senior AI Engineer dan Technical Lead untuk Bubu. Baca `docs/BUBU_PHASE_2_ROADMAP_TASKS_HANDOVER.md` dan `docs/PATCH_TASK_2_6_2_7_2_8_NOTES.md`. Pertahankan kontrak Phase 1 yang sudah disetujui. Implementasi kode untuk Task 2.2 hingga Task 2.8 sudah selesai di source dan lulus 203/203 unit test terfokus. Bantu saya memverifikasi deployment di VPS, menjalankan `npm test`, `npm run test:phase1`, dan `bash scripts/phase2-regression.sh`, lalu mencatat matriks acceptance WhatsApp akhir untuk menutup Phase 2.

## 1. Baseline source dan VPS

| Area | Bukti yang sudah diperoleh | Implikasi |
|---|---|---|
| Build | Bubu **2.4.0**. Enam file awal cocok dengan baseline VPS; patch bertahap Task 2.2, 2.3, 2.4, 2.5B, 2.5C, 2.6, 2.7, dan 2.8 telah diterapkan pada workspace. | Cocokkan hash terbaru di bawah sebelum deploy overlay ke VPS. |
| Runtime | Node shell dan Node PM2 **v24.22.1**. Bubu `/health` dan `/ready` HTTP 200. | Readiness membuktikan layanan dan cek SQLite merespons. Acceptance media WhatsApp tetap dicatat terpisah. |
| Database | `MAX(version)` pada `schema_migrations` adalah **9**. | Tidak ada migrasi skema baru pada Phase 2 (tetap v9). |
| Kapasitas | **2 CPU tersedia**, **1,9 GiB RAM total**, **23,7 GiB disk bebas** pada filesystem storage. | Single-concurrency guard aktif untuk `audioBusy` dan `videoBusy` di `MediaIntelligenceService`. |
| WAHA | **2026.10.1 · CORE · GOWS · WORKING**. GET versi dan sesi HTTP 200. Event terpasang `message` dan `session.status`. | Fixture GOWS untuk gambar, PTT, audio biasa, video, dan reply/quote sudah tercatat di `docs/BUBU_PHASE_2_TASK_2_1_TEST_EVIDENCE.md`. |
| Media lokal | FFmpeg dan FFprobe **6.1.1**, encoder `libopus` tersedia. Tesseract **5.3.4**, paket `ind` dan `eng` tersedia. | Digunakan untuk normalisasi gambar ke JPEG terukur, sampling frame video ber-timestamp, normalisasi WAV 16 kHz mono, dan encoding OGG/Opus 48 kHz. |
| STT dan TTS | Whisper.cpp (`/opt/whisper.cpp/build/bin/whisper-cli`, `ggml-base.bin`), Silero VAD (`ggml-silero-v6.2.0.bin`), dan Piper (`/opt/piper-venv/bin/piper`, `id_ID-news_tts-medium.onnx`) sudah diinstal dan diuji di VPS (`docs/BUBU_PHASE_2_5_TEST_EVIDENCE.docx`). | Integrasi STT + Silero VAD (Task 2.5B) dan jalur TTS Piper → Opus → `sendVoice` (Task 2.5C) sudah terhubung. |
| Batas aktif | Media aktif, **25 MiB**, visual image **4 MiB / 1280px**, audio **900 detik**, video **180 detik**, maksimal **8 frame**. | Batas ukuran dan dimensi visual ditegakkan sebelum pengiriman ke Sumopod. |
| Routing | `GROUP_POLICY=all`, mention grup wajib, media tanpa caption mengikuti kebijakan terpisah dengan `GROUP_MEDIA_REQUIRE_MENTION=false`. | Uji caption dan media-only secara terpisah. DM tetap dibatasi pemilik. |
| Sumopod | `fast` = `claude-haiku-5-5`. `balanced`, `coding`, dan `vision` = `claude-sonnet-5-5`. `reasoning` = `claude-opus-5-5`. `summary` = `gemini/gemini-3.1-pro-preview`. | `claude-sonnet-5-5` lulus probe kontrol teks, identifikasi 2 gambar tanpa teks, serta gambar + tool calling pada Task 2.1C dan dipilih pemilik sebagai model visual. |

### Identitas snapshot

1. **Snapshot awal Phase 2 (`bubu-phase2-handover-updated.tar.gz`)**:
   SHA-256 arsip: `6f5861a0b80c59965af5ef529513abfc5583dda3b5ea4143f951a6283a821a5e`.

2. **Snapshot setelah Task 2.5C (sebelum Task 2.6–2.8)**:
```text
3fc998e3cb27a9d41985f26145a6c21cbe78e55d8492889a5956dc3b80516910  package.json
0d8b75bbcfc8aeb37d14abc67e29ceac8f9e95f71df71a801026401a28997272  src/agent/message-processor.js
0d1c7789ae797625380a92130dcf3d76be907d3ea5689d70d4f952746db998fd  src/channels/waha/client.js
466a78f0031697dac39d53387ab80ccbe988ac00b8e8efcc8efcb8f6da0add5c  src/channels/response-handler.js
58ff782cf60d4f2d1c7191b8da063e4cdc2fb5843e772be8651e5ed011880460  src/p3/media/service.js
6ef93dfae17fbccaab1f03bc1335a05d01a4127332be1b710bcd09128304fe83  src/config/env.js
8bb3f3c8fb0740208da1c01ca2fbe17f5d96d67fbafcc1738bd86f510cb46489  src/agent/runtime.js
2d751034c791090c63f7ab7c86b88b58078226dd124996186dbcad2b5ea3a98e  src/index.js
d66e7887ed5ad89785de0dca86e3308914ae591b7a345a160aa21542e3795669  src/p1/documents/service.js
baa382dd235abebe28031057819b6b066e7f966eddd84aa9c525525edea227fc  src/providers/sumopod.js
```

3. **Snapshot terkini setelah Task 2.6–2.8**:
```text
3fc998e3cb27a9d41985f26145a6c21cbe78e55d8492889a5956dc3b80516910  package.json
70ced853855fbb069e8d124904555810f40bb66286b15e43ef9aac870ba6a6f0  src/agent/message-processor.js
0d1c7789ae797625380a92130dcf3d76be907d3ea5689d70d4f952746db998fd  src/channels/waha/client.js
466a78f0031697dac39d53387ab80ccbe988ac00b8e8efcc8efcb8f6da0add5c  src/channels/response-handler.js
44cbb3eda93d3347caf6563f2440aa46a3bcb5a58932390ababef0df8174d135  src/p3/media/service.js
90a6f92a5ee4345cf862b9cb86eebbe1751445f7111681694c4faefc01f21239  src/config/env.js
1a137a5af29239af1410d469e69b356f5a335cadb9400b032338a67be44f14b3  src/agent/runtime.js
9b6027240c4c00463c44c57ef7b4735d76cf1a25eb67eb4f9a3c79135b9040ea  src/index.js
f14e183dc5d19c740dcbe84799f1413942e629f2a6c35c7e77d2580a79d964fc  src/agent/model-router.js
0ff6edbe89f0bca3a7e680b05c65aa9bffbaba6dee10fd2cc1ebfc068fa9774e  src/providers/sumopod.js
d66e7887ed5ad89785de0dca86e3308914ae591b7a345a160aa21542e3795669  src/p1/documents/service.js
```

Suite unit terfokus pada workspace terisolasi lulus **203/203 tes** (0 gagal, 0 dilewati). Tiga file tes yang membutuhkan paket eksternal (`better-sqlite3`, `zod`, `exceljs`, `docx`) wajib dijalankan di VPS tempat `node_modules` terpasang melalui `npm test`, `npm run test:phase1`, dan `bash scripts/phase2-regression.sh`.

## 2. Cakupan dan kontrak Phase 1

Phase 2 mencakup pemahaman gambar, voice note masuk dan keluar, transkripsi dan ringkasan audio, pemahaman video, caption dan konteks pesan, serta konsistensi DM dan grup. `src/p3` adalah modul preprocessing dan multimodal internal. `src/p2` adalah modul Advanced Memory internal yang sudah terhubung. Pembangunan memory lanjutan tetap mengikuti Phase 5.

Setiap perubahan Phase 2 diuji terhadap kontrak berikut.

- **Ingress dan isolasi.** Validasi webhook, deduplikasi event, DM khusus pemilik, gate mention dan media-only grup, serta isolasi riwayat, memory, file, preferensi, dan konteks antara DM dan setiap grup. Presence berjalan setelah gate dan `stopTyping` tetap dibersihkan saat gagal.
- **Mode balasan.** `/voice on` memilih voice-only, `/voice both` memilih teks + suara, `/voice off` memilih teks, dan `/voice status` serta `/voice reset` berlaku per chat. Voice-only tetap fail-closed bila TTS gagal. Pengiriman parsial dicatat sesuai hasil.
- **Pengiriman dan approval.** Gunakan `ResponseHandler`, formatter WhatsApp untuk teks, dan jalur Piper/Opus yang ada. DOCX/XLSX dari grup hanya otomatis dikirim ke `ctx.chatId` grup asal setelah validasi. File dari DM mengikuti approval pemilik. Status `uncertain` direkonsiliasi sebelum pengiriman ulang.
- **Reliabilitas.** Pertahankan batas retry, dead-letter, idempotensi task dan tool, serta diagnostik finish reason, token dan argumen tool. Gunakan `/rangkum` sebagai perintah ringkasan aktual. Referensi lama yang menyebut `/summary` atau mode lama `/voice on` telah dikoreksi pada `docs/PHASE-1-FULL-REGRESSION-PLAN.md` dan `docs/P3-WHATSAPP-MULTIMODAL.md`.
- **Scope dan provider.** Sumopod tetap provider AI remote dengan `claude-sonnet-5-5` untuk input visual. Document Intelligence mendalam mengikuti Phase 3, fitur pengiriman native baru mengikuti Phase 4, agent dan memory lanjutan mengikuti Phase 5, serta redesign antrean dan hardening menyeluruh mengikuti Phase 6. Kutipan di Phase 2 dipakai sebagai konteks baca untuk memahami media.

## 3. Urutan pengerjaan dan status terkini

| Task | Status kode & unit test | Status VPS / WhatsApp acceptance | Dokumen bukti / patch |
|---|---|---|---|
| **2.1 — Audit kemampuan produksi** | **Selesai (2.1A–2.1D).** Inventaris VPS, fixture GOWS, probe Sumopod `claude-sonnet-5-5`, dan pemilihan kandidat model visual selesai. | Lulus untuk baseline, GOWS metadata, dan probe visual Sumopod. | `docs/BUBU_PHASE_2_TASK_2_1_TEST_EVIDENCE.md` |
| **2.2 — Pulihkan penanganan error media** | **Selesai.** Error media dilempar utuh ke `InboxWorker`; notice awal menghormati mode output chat; voice-only tetap fail-closed. | Menunggu re-verifikasi akhir bersama Task 2.8. | `docs/PATCH_TASK_2_2_NOTES.md` |
| **2.3 — Normalisasi dan unduhan media** | **Selesai.** Normalisasi struktur native GOWS, resolusi URL relatif, blokir origin asing/redirect/kredensial URL, validasi MIME & signature. | Menunggu konfirmasi acceptance lengkap pada Task 2.8. | `docs/PATCH_TASK_2_3_NOTES.md` |
| **2.4 — Caption, kutipan, dan konteks chat** | **Selesai.** Pemisahan `bodyText`, `captionContext`, `voiceInstruction`, `attachmentEvidence`, `quoteContext`, penolakan quote lintas chat, skip auto-memory pada media/quote. | Menunggu konfirmasi acceptance lengkap pada Task 2.8. | `docs/PATCH_TASK_2_4_NOTES.md` |
| **2.5 — Voice note dan audio** | **Selesai (2.5A, 2.5B, 2.5C).** Whisper `ggml-base.bin` + Silero VAD `ggml-silero-v6.2.0.bin`, normalisasi WAV 16 kHz, stop awal `noSpeech`, guard `audioBusy`, dan jalur Piper → Opus → `sendVoice`. | 2.5A–2.5B diuji di VPS (noise lingkungan di-skip atas keputusan pemilik); 2.5C menunggu uji kirim WAHA langsung di DM & grup. | `docs/BUBU_PHASE_2_5_TEST_EVIDENCE.docx`, `docs/PATCH_TASK_2_5_NOTES.md`, `docs/PATCH_TASK_2_5C_NOTES.md` |
| **2.6 — Pemahaman gambar** | **Selesai.** Routing visual ke `claude-sonnet-5-5`, normalisasi FFmpeg JPEG (`<=1280px`, `<=4 MiB`), sanitasi `data:image/jpeg;base64` di `SumopodProvider`, suplemen OCR & fallback `[OCR_FALLBACK]`. | Menunggu deploy overlay dan acceptance WhatsApp DM & grup. | `docs/PATCH_TASK_2_6_2_7_2_8_NOTES.md` |
| **2.7 — Pemahaman video** | **Selesai.** Ekstraksi frame ber-timestamp (`Frame #k [t=MM:SS.s]`), penggabungan transkrip audio Task 2.5, rekonsiliasi durasi metadata vs FFprobe, status `insufficient_sample` dan `partial_ocr_audio`, guard `videoBusy`. | Menunggu deploy overlay dan acceptance WhatsApp DM & grup. | `docs/PATCH_TASK_2_6_2_7_2_8_NOTES.md` |
| **2.8 — Regresi, performa, dan acceptance** | **Selesai (suite lokal & skrip regresi).** 203/203 tes unit lulus; `test/unit/phase2-regression-contract.test.js` dan `scripts/phase2-regression.sh` tersedia. | Gate rilis Phase 2 di VPS oleh pemilik. | `docs/PATCH_TASK_2_6_2_7_2_8_NOTES.md` |

## 4. Rincian task

### Task 2.1 — Selesaikan audit kemampuan produksi

- [x] **2.1A · Inventaris VPS & source.** Enam hash cocok, Node v24.22.1, SQLite v9, WAHA 2026.10.1 CORE/GOWS WORKING, kapasitas 2 vCPU / 1,9 GiB RAM / 23,7 GiB disk.
- [x] **2.1B · Metadata webhook GOWS.** Gambar dengan/tanpa caption, PTT OGG/Opus, audio biasa, video pendek, dan reply/quote gambar tercatat di `docs/BUBU_PHASE_2_TASK_2_1_TEST_EVIDENCE.md`.
- [x] **2.1C · Probe Sumopod.** `claude-sonnet-5-5` lulus kontrol teks, identifikasi 2 gambar tanpa teks (apel vs pisang), dan kombinasi input gambar + tool calling (`report_visual_observation`).
- [x] **2.1D · Keputusan arsitektur.** `claude-sonnet-5-5` dipilih sebagai model visual kandidat; Whisper base + Silero VAD + Piper `id_ID-news_tts-medium` dipilih untuk STT/TTS lokal dengan concurrency 1 job.

### Task 2.2 — Pulihkan penanganan error media

- [x] Kunci reproduksi dengan tes processor dan inbox (`test/unit/message-processor-media-errors.test.js`).
- [x] Perbaiki jalur error dengan mendelegasikan klasifikasi operasional ke `InboxWorker` dan mengirim notice validasi awal melalui `ResponseHandler` sesuai mode chat.
- [x] Verifikasi bahwa 403 dan input permanen berhenti tanpa retry, error sementara mengikuti batas backoff, `uncertain` tidak memicu pengiriman ulang, dan voice-only tetap fail-closed.
- [ ] Konfirmasi acceptance WhatsApp staging di DM dan grup bersama matriks Task 2.8.

### Task 2.3 — Normalisasi metadata dan unduhan

- [x] Tambahkan fixture GOWS untuk media valid, filename hilang, MIME berparameter, URL relatif, dan URL kosong (`test/unit/normalizer.test.js`, `test/unit/p3-media.test.js`, `test/unit/p1-services.test.js`).
- [x] Selaraskan parsing URL dan deteksi format sebelum download. Validasi origin dan redirect (`maxRedirects: 0`), serta MIME/ekstensi/signature dan ukuran.
- [ ] Buktikan penerimaan unduhan nyata pada matriks WhatsApp DM dan grup di VPS (Task 2.8).

### Task 2.4 — Caption, kutipan, dan konteks chat

- [x] Pisahkan instruksi saat ini (`bodyText`), caption (`captionContext`), instruksi suara PTT (`voiceInstruction`), bukti lampiran (`attachmentEvidence`), dan kutipan (`quoteContext`).
- [x] Ambil quote dari webhook bila tersedia, tolak quote lintas chat (`quote.rejected = true`), dan lewati auto-memory pada giliran media/quote (`test/unit/message-context.test.js`).
- [ ] Konfirmasi acceptance WhatsApp DM dan grup bersama matriks Task 2.8.

### Task 2.5 — Voice note dan audio intelligence

- [x] **2.5A · Prasyarat.** Whisper.cpp (`ggml-base.bin`), Silero VAD (`ggml-silero-v6.2.0.bin`), dan Piper (`id_ID-news_tts-medium.onnx`) diuji di VPS (`docs/BUBU_PHASE_2_5_TEST_EVIDENCE.docx`).
- [x] **2.5B · STT dan ringkasan.** Normalisasi FFmpeg 16 kHz mono WAV, eksekusi Silero VAD + Whisper, penanganan `noSpeech: true` tanpa memanggil Agent, dan guard `audioBusy` (`docs/PATCH_TASK_2_5_NOTES.md`). *(Catatan: uji background noise lingkungan di-skip atas keputusan pemilik).*
- [x] **2.5C · Output.** Verifikasi kontrak Piper → FFmpeg OGG/Opus → `sendVoice` di DM dan grup untuk mode `text`, `voice`, dan `both`, termasuk fail-closed dan partial uncertain delivery (`test/unit/voice-output.test.js`, `docs/PATCH_TASK_2_5C_NOTES.md`).
- [ ] Konfirmasi pengiriman dan pemutaran voice note nyata melalui WAHA GOWS di DM dan grup (Task 2.8).

### Task 2.6 — Pemahaman gambar

- [x] Pilih jalur visual Sumopod `claude-sonnet-5-5` berdasarkan hasil 2.1C dengan routing otomatis `needsVision: true` di `ModelRouter` (`src/agent/model-router.js`, `src/config/env.js`).
- [x] Hubungkan bukti visual ke konteks 2.4 (`[UNTRUSTED_ATTACHMENT_EVIDENCE]`). Normalisasi gambar ke JPEG terukur (`<=1280px`, `<=4 MiB`) di `MediaIntelligenceService`, jaga cleanup `workDir` dan file inbound, serta blokir URL privat WAHA/kredensial di `SumopodProvider` (`src/providers/sumopod.js`).
- [x] Uji foto tanpa tulisan dengan dua objek berbeda, screenshot berteks, pertanyaan caption di DM dan grup, serta fallback OCR berlabel (`[OCR_FALLBACK]`) pada `test/unit/image-understanding.test.js`.
- [ ] Konfirmasi acceptance WhatsApp untuk gambar tanpa teks dan screenshot di DM dan grup (Task 2.8).

### Task 2.7 — Pemahaman visual-temporal video

- [x] Analisis frame visual dengan timestamp asli (`Frame #k [t=MM:SS.s]`) digabung dengan transkripsi soundtrack Task 2.5 (`src/p3/media/service.js`). Rekonsiliasi durasi metadata WAHA dan FFprobe (`durationSeconds` vs `declaredDurationSeconds`).
- [x] Uji klip sunyi tanpa tulisan dengan perubahan keadaan berurutan, klip dengan soundtrack, klip terlalu pendek (`temporalStatus: 'insufficient_sample'`), klip melewati batas durasi, dan mode parsial (`visualMode: 'partial_ocr_audio'`, `partialOnly: true`) pada `test/unit/video-understanding.test.js`.
- [ ] Konfirmasi acceptance WhatsApp video di DM dan grup serta pengukuran resource di VPS (Task 2.8).

### Task 2.8 — Regresi, performa, dan acceptance

- [x] Koreksi referensi `/rangkum` dan mode `/voice` pada dokumentasi regresi, tambahkan `test/unit/phase2-regression-contract.test.js` dan `scripts/phase2-regression.sh`, serta jalankan 203/203 tes unit terfokus di workspace.
- [ ] Jalankan `npm test`, `npm run test:phase1`, dan `bash scripts/phase2-regression.sh` di VPS dengan dependensi lengkap.
- [ ] Jalankan matriks WhatsApp untuk DM pemilik, DM non-pemilik, grup A, dan grup B.
- [ ] Catat konfirmasi pemilik per skenario (`LULUS`, `GAGAL`, `TERBLOKIR`, `SKIPPED`, atau `BELUM DIUJI`).

## 5. Prosedur setiap patch dan penutupan fase

1. **Sebelum deploy.** Pemilik memverifikasi hash file target dan menyimpan backup source/config serta SQLite (`npm run backup`).
2. **Deploy oleh pemilik.** Terapkan file yang berubah tanpa menimpa `.env`, `data/`, atau `storage/`. Jalankan `node --check`, `npm test`, `npm run test:phase1`, dan `bash scripts/phase2-regression.sh`. Restart PM2 hanya saat siap menerima trafik uji.
3. **Rollback.** Kembalikan file source yang dicadangkan dan restart PM2 jika ditemukan regresi. Tidak ada migrasi database pada Phase 2.
4. **Tutup task berdasarkan bukti.** Gunakan format `task | build | skenario | DM/grup | hasil | durasi/kategori | konfirmasi pemilik`.

**Phase 2 lulus** setelah pemilik mengonfirmasi keenam sasaran multimodal di DM dan grup, termasuk gambar tanpa tulisan, urutan visual pada video, PTT dua arah, audio Indonesia, konteks same-chat, dan isolasi grup, serta `npm run test:phase1` dan `bash scripts/phase2-regression.sh` lulus di VPS.
