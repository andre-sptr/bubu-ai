# Bubu v2.4.0 — Personal & Community WhatsApp AI Agent

Rebuild bersih (tanpa kode atau data Bubu v1) untuk asisten AI WhatsApp hybrid (Personal DM + Grup Komunitas) berbasis **Node.js**, **Fastify**, **SQLite (WAL)**, **WAHA (GOWS)**, dan **Sumopod AI Gateway**, dilengkapi pemrosesan multimodal lokal (**FFmpeg**, **Tesseract OCR**, **Whisper.cpp + Silero VAD**, dan **Piper TTS**).

---

## 1. Status Roadmap & Fase Proyek

| Fase | Nama Fase | Status | Dokumen Acuan |
|---|---|---|---|
| **P0–P3 (Fondasi)** | Core Agent, Advanced Tools, Memory, Multimodal Baseline | **Selesai** | `docs/P0-CORE-AGENT.md` s/d `docs/P3-WHATSAPP-MULTIMODAL.md` |
| **Phase 1** | Core Reliability & Response Control (Task 1.1–1.9) | **Selesai & Disetujui** | `docs/PHASE-1-FULL-REGRESSION-PLAN.md` |
| **Phase 2** | Full Multimodal WhatsApp (Task 2.1–2.8) | **Kode & Unit Test Selesai** · Menunggu Acceptance VPS | `docs/PHASE-2-ROADMAP.md`, `docs/TASK-2.6-2.8-VISION-VIDEO-REGRESSION.md` |
| **Phase 3** | Deep Document Intelligence (Task 3.1–3.8) | **Kode & Unit Test Selesai (`217/217`)** · Menunggu Acceptance VPS | `docs/PHASE-3-ROADMAP.md` |
| **Phase 4** | Native WhatsApp Outbound Features | Berikutnya | — |
| **Phase 5** | Advanced Agent & Memory Lifecycle | Berikutnya | — |
| **Phase 6** | Queue Redesign & End-to-End Hardening | Berikutnya | — |

---

## 2. Profil & Spesifikasi VPS Produksi

Informasi lingkungan produksi saat ini (berdasarkan audit VPS pada `docs/TASK-2.1-PRODUCTION-AUDIT-EVIDENCE.md` dan `docs/TASK-2.5-VOICE-AUDIO-EVIDENCE.docx`):

| Komponen | Spesifikasi / Lokasi di VPS | Catatan Operasional |
|---|---|---|
| **Direktori Proyek** | `/www/wwwroot/bot-project/bubu` | Dikelola dengan PM2 (`ecosystem.config.cjs`, proses `bubu`, `max_memory_restart: 512M`). |
| **Kapasitas Server** | **2 vCPU**, **1,9 GiB RAM total**, **23,7 GiB disk bebas** | Dilindungi single-concurrency guard (`audioBusy` & `videoBusy`) pada `MediaIntelligenceService` dan `maxConcurrentJobs = 1`. |
| **Runtime Node.js** | **Node.js v24.22.1** (shell & PM2) | Memenuhi syarat engine `>=22.0.0`. |
| **Endpoint Layanan** | `http://127.0.0.1:3088` (`/webhook`, `/health`, `/ready`) | Readiness memverifikasi koneksi SQLite dan status worker. |
| **Database** | SQLite (`./data/bubu.sqlite`), **Schema Version 9** | Mode WAL + Foreign Keys aktif; backup online melalui `npm run backup`. |
| **Storage Dokumen & Media** | `./storage` (`./storage/inbound`, `./storage/generated`) | Berada di luar public web root (`mode 0700`); file media masuk & direktori kerja sementara dihapus otomatis di blok `finally`. |
| **WAHA Gateway** | **WAHA 2026.10.1 · CORE · GOWS · WORKING** | Event aktif: `message` dan `session.status`. Mendukung unduhan media lokal, pengiriman teks/file/gambar/video, `sendVoice`, serta presence (`sendSeen`, `startTyping`, `stopTyping`). |
| **FFmpeg & FFprobe** | **v6.1.1** (`ffmpeg`, `ffprobe`, encoder `libopus` aktif) | Normalisasi gambar JPEG (`<=1280px`), ekstraksi frame video ber-timestamp, konversi audio WAV 16 kHz mono, dan encoding voice note OGG/Opus 48 kHz 32 kbps. |
| **OCR Lokal** | **Tesseract v5.3.4** (`tesseract`, bahasa `ind+eng`) | Digunakan sebagai suplemen teks pada gambar/video dan fallback berlabel `[OCR_FALLBACK]`. |
| **STT + VAD Lokal** | **Whisper.cpp** (`/opt/whisper.cpp/build/bin/whisper-cli`)<br>Model: `/opt/whisper.cpp/models/ggml-base.bin`<br>VAD: `/opt/whisper.cpp/models/ggml-silero-v6.2.0.bin` | Berjalan dengan `--vad -vt 0.50 -vspd 250 -vsd 500 -vp 100 -t 2 -ng`. Audio tanpa ucapan menghasilkan `noSpeech: true` dan berhenti sebelum memanggil Agent. |
| **TTS Lokal** | **Piper v1.8.0** (`/opt/piper-venv/bin/piper`)<br>Model: `/opt/piper-voices/id_ID-news_tts-medium.onnx` | Menghasilkan WAV lalu dikonversi FFmpeg ke OGG/Opus (`audio/ogg; codecs=opus`) untuk dikirim melalui WAHA `/api/sendVoice`. |

---

## 3. Kebijakan Konfigurasi & Minimal `.env`

Seluruh model AI, batas ukuran media, serta path binary/model lokal di VPS sudah memiliki **nilai default produksi langsung di [`src/config/env.js`](src/config/env.js)**. File `.env` di VPS dijaga tetap **minimal** (hanya berisi identitas, URL koneksi, dan kredensial rahasia):

```dotenv
NODE_ENV=production

# WhatsApp / WAHA
OWNER_JID=628xxxxxxxxxx@c.us
WAHA_BASE_URL=http://127.0.0.1:3000
WAHA_SESSION=default
WAHA_WEBHOOK_TOKEN=replace-with-a-long-random-secret
WAHA_API_KEY=

# AI Provider
SUMOPOD_API_KEY=
```

*(Opsional: tambahkan `TAVILY_API_KEY` jika ingin mengaktifkan tool `web_search`. Lihat `docs/ENVIRONMENT-CONFIGURATION.md` untuk daftar lengkap variabel override opsional).*

---

## 4. Routing Model AI (Sumopod)

Sumopod (`https://ai.sumopod.com/v1`) adalah satu-satunya provider LLM dan embedding remote. Pemilihan model dilakukan secara dinamis oleh [`ModelRouter`](src/agent/model-router.js):

| Tier | Default Model ID | Kegunaan Utama |
|---|---|---|
| `fast` | `claude-haiku-5-5` | Pertanyaan singkat, sapaan, klasifikasi ringan |
| `balanced` | `claude-sonnet-5-5` | Tugas asisten harian, eksekusi tool umum |
| `vision` | `claude-sonnet-5-5` | Pemahaman visual gambar & rangkaian frame video (`needsVision: true`, terverifikasi mendukung vision + tool calling pada Task 2.1C) |
| `coding` | `claude-sonnet-5-5` | Pembuatan dan debugging kode |
| `reasoning` | `claude-opus-5-5` | Perencanaan multi-langkah kompleks & penalaran mendalam |
| `summary` | `gemini/gemini-3.1-pro-preview` | Ringkasan konteks panjang (`/rangkum`, dokumen besar) |
| `embedding` | `gemini/gemini-embedding-001` | Vektor memori semantik (`POST /embeddings` dengan circuit-breaker 5 menit ke pencarian leksikal) |

---

## 5. Kapabilitas Utama Saat Ini (Hingga Phase 2)

### A. Keandalan Inti & Kontrol Respons (Phase 1)
- **Antrean Inbox Durable (`InboxWorker`):** Deduplikasi event webhook, klaim atomik, retry eksponensial terbatas (`maxAttempts = 5`), transisi `dead`-letter dengan notifikasi aman, dan pemulihan event `stale` saat startup.
- **Idempotensi & Rekonsiliasi:** ID task deterministik dari kunci event, ledger idempotensi `tool_executions`, dan status pengiriman `uncertain` yang **tidak pernah** dikirim ulang otomatis untuk mencegah pesan/file ganda.
- **Unified `ResponseHandler`:** Seluruh pengiriman keluar (`sendText`, `sendVoice`, `sendFile`, `sendImage`, `sendVideo`, `sendAssistantResponse`) terpusat di satu gerbang dengan pemformatan otomatis Markdown → sintaks native WhatsApp.
- **Isolasi DM vs Grup:**
  - DM pribadi hanya merespons `OWNER_JID`. Pengiriman file keluar dari DM memerlukan persetujuan pemilik (`/approve <id>` atau `/deny <id>`).
  - Grup mematuhi gate mention (`Bubu` / `@bot` / perintah `/`) untuk pesan teks dan pesan media ber-caption, serta kebijakan terpisah untuk media tanpa caption (`GROUP_MEDIA_REQUIRE_MENTION=false`).
  - Memori, riwayat percakapan, task, proyek, preferensi `/voice`, dan file dokumen terisolasi ketat per workspace (`personal` vs `group` per `chat_id`).

### B. Multimodal WhatsApp Penuh (Phase 2)
- **Pemahaman Gambar (`Task 2.6`):** Gambar dinormalisasi dengan FFmpeg (`<=1280px`, `<=4 MiB` JPEG), divalidasi signature magic-byte, dan dikirim sebagai `data:image/jpeg;base64` ke model vision `claude-sonnet-5-5` bersama suplemen OCR Tesseract (`ind+eng`). URL privat WAHA diblokir di `SumopodProvider`. Jika vision gagal/nonaktif, otomatis beralih ke `[OCR_FALLBACK]`.
- **Pemahaman Visual-Temporal Video (`Task 2.7`):** Mengekstrak hingga `8` sampel frame ber-timestamp (`Frame #k [t=MM:SS.s]`), menggabungkan analisis visual frame + OCR frame + transkripsi soundtrack audio (Silero VAD + Whisper), merekonsiliasi durasi metadata WAHA vs FFprobe, serta menandai video terlalu pendek (`<2` frame atau `<1,5` detik) sebagai `temporalStatus: 'insufficient_sample'`.
- **Voice Note Masuk & Keluar (`Task 2.5`):**
  - Voice note (PTT) masuk ditranskripsikan sebagai instruksi suara pengguna saat ini; file audio biasa diperlakukan sebagai bukti lampiran (`[UNTRUSTED_ATTACHMENT_EVIDENCE]`).
  - Perintah `/voice on` (voice-only, fail-closed tanpa fallback teks jika TTS gagal), `/voice both` (teks + voice note), `/voice off` (teks saja), `/voice status`, dan `/voice reset` tersimpan per chat di SQLite.
- **Konteks Caption & Reply/Quote (`Task 2.4`):** Memisahkan `bodyText`, `captionContext`, `voiceInstruction`, `attachmentEvidence`, dan `quoteContext`. Kutipan lintas chat (`remoteJid` berbeda) ditolak otomatis (`quote.rejected = true`), dan giliran media/quote melewati auto-memory capture.

### C. Deep Document Intelligence, Web, Memori, & Produktivitas (P1, P2, & Phase 3)
- **Ingesti PDF Digital, Scan, & Hybrid (`Task 3.2`):** Mengekstrak teks PDF per halaman (`--- [HALAMAN N — TEKS ASLI] ---`) dan otomatis menjalankan fallback render + Tesseract OCR (`ind+eng`) untuk halaman scan/minim teks (`--- [HALAMAN N — OCR SCAN] ---`), dilengkapi guard konkurensi tunggal `ocrBusy` dan pembersihan file sementara otomatis.
- **Ekstraksi Terstruktur, Navigasi Halaman, & Snippet Search (`Task 3.3`):** Mengekstrak struktur heading (`# / ## / ###`), bullet list, dan tabel pipa dari `word/document.xml` pada file DOCX; mendukung pembacaan per halaman/rentang (`read_document` dengan `page`, `startPage`, `endPage`) serta pencarian cuplikan kontekstual di sekitar kata kunci (`search_document` dengan label halaman).
- **Analitik Spreadsheet & CSV Deterministik (`Task 3.4`):** Auto-deteksi delimiter CSV (`,`, `;`, `\t`), dukungan sel multi-baris ber-quote, normalisasi angka Indonesia (`Rp 1.250.000,50`) & internasional, serta perhitungan statistik deterministik (`count`, `sum`, `avg`, `min`, `max`), filter baris, dan agregasi `groupByColumn` pada `analyze_spreadsheet`.
- **Resolusi Reply Dokumen, Perbandingan, & Siklus Hidup (`Task 3.5` & `3.7`):** Menghubungkan reply/quote pesan dokumen di chat yang sama ke `documentId` workspace secara otomatis, membandingkan dua dokumen dalam satu workspace (`compare_documents`), dan menghapus dokumen beserta file fisiknya (`delete_document`).
- **Pembuatan DOCX Kaya, XLSX Multi-Sheet, & PDF Native (`Task 3.6`):** Merender inline Markdown (`**bold**`, `*italic*`, `` `code` ``) pada DOCX, membuat workbook XLSX berformula aman (`create_spreadsheet`), serta membuat dokumen PDF multi-halaman siap cetak (`create_pdf` / `create_document(format='pdf')`). Di grup, file otomatis dikirim ke `ctx.chatId` grup asal setelah verifikasi workspace; di DM pribadi wajib melalui persetujuan pemilik (`/approve <id>`).
- **Riset Web Aman:** `web_search` (opsional dengan `TAVILY_API_KEY`) dan `web_fetch` (memblokir IP privat/localhost dan kredensial URL).
- **Memori Hibrida & Proyek:** Pencarian gabungan kemiripan kosinus + leksikal + signifikansi + kebaruan, ekstraksi memori konservatif berbasis sinyal eksplisit, serta manajemen task (`create_task`, `list_tasks`, `update_task`, `complete_task`) dan pengingat (`create_reminder`, `list_reminders`, `cancel_reminder`).

---

## 6. Struktur Direktori Proyek

```text
bubu/
├── data/                       # Database SQLite lokal (bubu.sqlite, WAL/SHM)
├── docs/                       # Dokumentasi arsitektur, roadmap fase, dan laporan task
│   ├── DEPLOY-AAPANEL.md
│   ├── ENVIRONMENT-CONFIGURATION.md
│   ├── MODEL-ROUTING.md
│   ├── P0-CORE-AGENT.md ... P3-WHATSAPP-MULTIMODAL.md
│   ├── PHASE-1-FULL-REGRESSION-PLAN.md
│   ├── PHASE-2-ROADMAP.md
│   ├── PHASE-3-ROADMAP.md
│   ├── TASK-1.1-*.md ... TASK-1.8-*.md
│   ├── TASK-2.1-*.md ... TASK-2.6-2.8-*.md
│   └── TEST-REPORT.md
├── scripts/                    # Skrip operasional & regresi otomatis
│   ├── backup.js               # Online backup SQLite + storage
│   ├── list-models.js          # Cek katalog model Sumopod
│   ├── phase1-regression.sh    # Gate regresi otomatis Phase 1
│   ├── phase2-regression.sh    # Gate regresi otomatis Phase 2
│   ├── phase3-regression.sh    # Gate regresi otomatis Phase 3
│   └── smoke-tool-calling.js   # Uji smoke tool calling
├── src/
│   ├── agent/                  # Runtime, MessageProcessor, ModelRouter, Approval, RateLimiter
│   ├── channels/               # ResponseHandler, WhatsApp Formatter, WAHA Client & Normalizer
│   ├── config/                 # Konfigurasi & default produksi (env.js)
│   ├── db/                     # SQLite DatabaseStore & migrasi v1–v9 (database.js)
│   ├── p1/                     # DocumentService (PDF OCR/DOCX/XLSX/CSV/TXT/PDF Gen), Web Search/Fetch, P1 Tools
│   ├── p2/                     # MemoryService, Vector cosine similarity, P2 Tools
│   ├── p3/                     # MediaIntelligenceService (Vision, Video frames, STT+VAD, Piper TTS)
│   ├── providers/              # SumopodProvider (OpenAI-compatible + image_url sanitizer)
│   ├── utils/                  # Klasifikasi error operasional (error-policy.js)
│   ├── workers/                # InboxWorker & ReminderWorker
│   ├── app.js                  # Server HTTP Fastify (/webhook, /health, /ready)
│   └── index.js                # Bootstrap aplikasi & graceful shutdown
├── storage/                    # Penyimpanan privat dokumen & media sementara
└── test/
    ├── integration/            # Tes integrasi SQLite & migrasi (database.test.js)
    └── unit/                   # 30 file unit test kontrak Phase 1, Phase 2, & Phase 3
```

---

## 7. Perintah Operasional & Pengujian di VPS

```bash
# Masuk ke direktori proyek di VPS
cd /www/wwwroot/bot-project/bubu

# 1. Backup SQLite + storage sebelum update
npm run backup

# 2. Jalankan seluruh unit & integration test
npm test

# 3. Jalankan gate regresi Phase 1, Phase 2, & Phase 3 di VPS
npm run test:phase1
bash scripts/phase2-regression.sh
bash scripts/phase3-regression.sh

# 4. Restart layanan melalui PM2 & cek kesehatan
pm2 restart bubu
curl -s http://127.0.0.1:3088/health
curl -s http://127.0.0.1:3088/ready
```
