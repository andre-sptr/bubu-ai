# Bubu v2.4.0 — Personal & Community WhatsApp AI Agent

Rebuild bersih (tanpa kode atau data Bubu v1) untuk asisten AI WhatsApp hybrid (Personal DM + Grup Komunitas) berbasis **Node.js**, **Fastify**, **SQLite (WAL)**, **WAHA (GOWS)**, dan **Sumopod AI Gateway**, dilengkapi pemrosesan multimodal lokal (**FFmpeg**, **Tesseract OCR**, **Whisper.cpp + Silero VAD**, dan **Piper TTS**).

---

## 1. Status Roadmap & Fase Proyek

| Fase | Nama Fase | Status | Cakupan Utama |
|---|---|---|---|
| **P0–P3 (Fondasi)** | Core Agent, Advanced Tools, Memory, Multimodal Baseline | **Selesai** | Runtime agent, memori hibrida, pencarian web, dokumen & media baseline |
| **Phase 1** | Core Reliability & Response Control (Task 1.1–1.9) | **Selesai & Disetujui** | Antrean durable SQLite, idempotensi, unified `ResponseHandler`, isolasi DM/grup |
| **Phase 2** | Full Multimodal WhatsApp (Task 2.1–2.8) | **Kode & Unit Test Selesai** | Pemahaman gambar/video ber-timestamp, STT + Silero VAD, Piper TTS & mode `/voice` |
| **Phase 3** | Deep Document Intelligence (Task 3.1–3.8) | **Kode & Unit Test Selesai** | PDF hybrid + OCR, DOCX XML terstruktur, analitik spreadsheet, generasi DOCX/XLSX/PDF |
| **Phase 4** | Native WhatsApp Outbound Features (Task 4.1–4.8) | **Kode & Unit Test Selesai** | 14 tools native WAHA (reaksi, polling, lokasi, vCard, link preview, edit/delete pesan bot, persetujuan lintas-chat, info grup, cek nomor, riwayat DM, & monitor sesi/identitas bot) |
| **Phase 5** | Advanced Agent & Memory Lifecycle (Task 5.1–5.8) | **Kode & Unit Test Selesai** | Siklus hidup memori (12 memory tools), migrasi v11, budget prompt JSON-aman, eskalasi tier dinamis, & perintah `/memory` |
| **Phase 6** | Queue Redesign & End-to-End Hardening (Task 6.1–6.8) | **Kode & Unit Test Selesai** | Antrean prioritas + FIFO per-chat, konkurensi multi-slot terbatas, `/queue`, retensi & cleanup temp, backup terverifikasi `integrity_check`, PDF token/table wrapping, & normalisasi XLSX |
| **Observatorium 3D & Model** | 3D Pipeline Visualizer (`waha.andresptr.site`) & DeepSeek V4 | **Aktif di Produksi** | Telemetri SSE `/api/visualizer/*` tersanitasi, kantor futuristik 3D + padang rumput (`Three.js`), kontrol simulasi 1-baris, serta routing default `deepseek-v4-pro` / `deepseek-flash` |

---

## 2. Profil & Spesifikasi VPS Produksi

Informasi lingkungan produksi target:

| Komponen | Spesifikasi / Lokasi di VPS | Catatan Operasional |
|---|---|---|
| **Direktori Proyek** | `/opt/apps/bubu-ai` | Dikelola dengan PM2 (`ecosystem.config.cjs`, proses `bubu`, `max_memory_restart: 1G`). |
| **Kapasitas Server** | **2 vCPU**, **7,5 GiB RAM**, Ubuntu `24.04.5 LTS` | Dijalankan bersama `1Panel + OpenResty`; dilindungi single-concurrency guard (`audioBusy` & `videoBusy`) pada `MediaIntelligenceService` dan `maxConcurrentJobs = 1` (dapat dikonfigurasi via `AGENT_MAX_CONCURRENT_JOBS` dengan serialisasi FIFO per chat). |
| **Runtime Node.js** | **Node.js v26.13.1** (`engines: >=22.0.0`) | `better-sqlite3` v12+ menyediakan prebuilt binary tanpa kompilasi C++ lokal. |
| **Endpoint Layanan** | `http://127.0.0.1:3088` (`/webhook`, `/health`, `/ready`, `/api/visualizer/*`) | Readiness memverifikasi SQLite & worker. Bridge webhook internal Docker-to-host di `10.3.14.216:3089` (ACL `172.19/20.0.0/16`); frontend publik `https://waha.andresptr.site` hanya mem-proxy `/api/visualizer/snapshot` & `/api/visualizer/stream` (tanpa `/webhook`). |
| **Database** | SQLite (`./data/bubu.sqlite`), **Schema Version 12** | Mode WAL + Foreign Keys aktif; backup online terverifikasi `PRAGMA integrity_check` & rotasi retensi melalui `npm run backup` (cron harian `03:00`). |
| **Storage Dokumen & Media** | `./storage` (`./storage/inbound`, `./storage/generated`) | Berada di luar public web root (`mode 0700`); file media masuk & direktori kerja sementara dihapus otomatis di blok `finally`. |
| **WAHA Gateway** | **WAHA 2026.10.1 · CORE · GOWS · WORKING** | Event aktif: `message`, `session.status`, dan `poll.vote`. Mendukung unduhan media lokal, pengiriman teks/file/gambar/video, `sendVoice`, serta presence (`sendSeen`, `startTyping`, `stopTyping`). |
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

*(Opsional: tambahkan `TAVILY_API_KEY` jika ingin mengaktifkan tool `web_search`. Lihat [`src/config/env.js`](src/config/env.js) untuk daftar lengkap variabel override opsional).*

---

## 4. Routing Model AI (Sumopod)

Sumopod (`https://ai.sumopod.com/v1`) adalah satu-satunya provider LLM dan embedding remote. Pemilihan model dilakukan secara dinamis oleh [`ModelRouter`](src/agent/model-router.js):

| Tier | Default Model ID | Kegunaan Utama |
|---|---|---|
| `fast` | `deepseek-v4-pro` | Pertanyaan singkat, sapaan, klasifikasi ringan |
| `balanced` | `deepseek-v4-pro` | Tugas asisten harian, eksekusi tool umum |
| `vision` | `deepseek-flash` | Pemahaman visual gambar & rangkaian frame video (`needsVision: true`) |
| `coding` | `deepseek-v4-pro` | Pembuatan dan debugging kode |
| `reasoning` | `deepseek-v4-pro` | Perencanaan multi-langkah kompleks & penalaran mendalam |
| `summary` | `deepseek-v4-pro` | Ringkasan konteks panjang (`/rangkum`, dokumen besar) |
| `embedding` | `gemini/gemini-embedding-001` | Vektor memori semantik (`POST /embeddings` dengan circuit-breaker 5 menit ke pencarian leksikal) |

- **Gating Kemampuan & Ruang Token Thinking:** Seluruh tier teks (`fast`, `balanced`, `reasoning`, `coding`, `summary`) menandai `supportsVision: false` sehingga pesan dengan lampiran gambar/frame video (`needsVision: true`) selalu dirutekan ke `deepseek-flash` (`supportsVision: true`). Karena `deepseek-v4-pro` memproduksi `reasoning_content` yang ikut menghitung batas `max_tokens`, pemanggilan ekstraksi memori (`src/memory/memory-service.js`: `2048` token / timeout `25000` ms), finalizer batas putaran (`src/agent/runtime.js`: `2400` token), dan perintah `/rangkum` (`src/agent/command-handler.js`: hingga `4096` token) diberi ruang token tambahan, serta estimasi biaya `/usage` didukung tarif `deepseekPro` dan `deepseekFlash` di [`src/utils/model-pricing.js`](src/utils/model-pricing.js).

---

## 5. Kapabilitas Utama Saat Ini (Hingga Phase 6)

### A. Keandalan Inti & Kontrol Respons (Phase 1)
- **Antrean Inbox Durable (`InboxWorker`):** Deduplikasi event webhook, klaim atomik, retry eksponensial terbatas (`maxAttempts = 5`), transisi `dead`-letter dengan notifikasi aman, dan pemulihan event `stale` saat startup.
- **Idempotensi & Rekonsiliasi:** ID task deterministik dari kunci event, ledger idempotensi `tool_executions`, dan status pengiriman `uncertain` yang **tidak pernah** dikirim ulang otomatis untuk mencegah pesan/file ganda.
- **Unified `ResponseHandler`:** Seluruh pengiriman keluar (`sendText`, `sendVoice`, `sendFile`, `sendImage`, `sendVideo`, `sendAssistantResponse`) terpusat di satu gerbang dengan pemformatan otomatis Markdown → sintaks native WhatsApp.
- **Isolasi DM vs Grup:**
  - DM pribadi hanya merespons `OWNER_JID`. Pengiriman file keluar dari DM memerlukan persetujuan pemilik (`/approve <id>` atau `/deny <id>`).
  - Grup mematuhi gate mention (`Bubu` / `@bot` / perintah `/`) untuk pesan teks dan pesan media ber-caption, serta kebijakan terpisah untuk media tanpa caption (`GROUP_MEDIA_REQUIRE_MENTION=false`).
  - Memori, riwayat percakapan, task, proyek, preferensi `/voice`, dan file dokumen terisolasi ketat per workspace (`personal` vs `group` per `chat_id`).

### B. Multimodal WhatsApp Penuh (Phase 2)
- **Pemahaman Gambar (`Task 2.6`):** Gambar dinormalisasi dengan FFmpeg (`<=1280px`, `<=4 MiB` JPEG), divalidasi signature magic-byte, dan dikirim sebagai `data:image/jpeg;base64` ke model vision `deepseek-flash` bersama suplemen OCR Tesseract (`ind+eng`). URL privat WAHA diblokir di `SumopodProvider`. Jika vision gagal/nonaktif, otomatis beralih ke `[OCR_FALLBACK]`.
- **Pemahaman Visual-Temporal Video (`Task 2.7`):** Mengekstrak hingga `8` sampel frame ber-timestamp (`Frame #k [t=MM:SS.s]`), menggabungkan analisis visual frame + OCR frame + transkripsi soundtrack audio (Silero VAD + Whisper), merekonsiliasi durasi metadata WAHA vs FFprobe, serta menandai video terlalu pendek (`<2` frame atau `<1,5` detik) sebagai `temporalStatus: 'insufficient_sample'`.
- **Voice Note Masuk & Keluar (`Task 2.5`):**
  - Voice note (PTT) masuk ditranskripsikan sebagai instruksi suara pengguna saat ini; file audio biasa diperlakukan sebagai bukti lampiran (`[UNTRUSTED_ATTACHMENT_EVIDENCE]`).
  - Perintah `/voice on` (voice-only, fail-closed tanpa fallback teks jika TTS gagal), `/voice both` (teks + voice note), `/voice off` (teks saja), `/voice status`, dan `/voice reset` tersimpan per chat di SQLite.
- **Konteks Caption & Reply/Quote (`Task 2.4`):** Memisahkan `bodyText`, `captionContext`, `voiceInstruction`, `attachmentEvidence`, dan `quoteContext`. Kutipan lintas chat (`remoteJid` berbeda) ditolak otomatis (`quote.rejected = true`), dan giliran media/quote melewati auto-memory capture.

### C. Deep Document Intelligence, Web, Memori, & Produktivitas (Phase 3)
- **Ingesti PDF Digital, Scan, & Hybrid (`Task 3.2`):** Mengekstrak teks PDF per halaman (`--- [HALAMAN N — TEKS ASLI] ---`) dan otomatis menjalankan fallback render + Tesseract OCR (`ind+eng`) untuk halaman scan/minim teks (`--- [HALAMAN N — OCR SCAN] ---`), dilengkapi guard konkurensi tunggal `ocrBusy` dan pembersihan file sementara otomatis.
- **Ekstraksi Terstruktur, Navigasi Halaman, & Snippet Search (`Task 3.3`):** Mengekstrak struktur heading (`# / ## / ###`), bullet list, dan tabel pipa dari `word/document.xml` pada file DOCX; mendukung pembacaan per halaman/rentang (`read_document` dengan `page`, `startPage`, `endPage`) serta pencarian cuplikan kontekstual di sekitar kata kunci (`search_document` dengan label halaman).
- **Analitik Spreadsheet & CSV Deterministik (`Task 3.4`):** Auto-deteksi delimiter CSV (`,`, `;`, `\t`), dukungan sel multi-baris ber-quote, normalisasi angka Indonesia (`Rp 1.250.000,50`) & internasional, serta perhitungan statistik deterministik (`count`, `sum`, `avg`, `min`, `max`), filter baris, dan agregasi `groupByColumn` pada `analyze_spreadsheet`.
- **Resolusi Reply Dokumen, Perbandingan, & Siklus Hidup (`Task 3.5` & `3.7`):** Menghubungkan reply/quote pesan dokumen di chat yang sama ke `documentId` workspace secara otomatis, membandingkan dua dokumen dalam satu workspace (`compare_documents`), dan menghapus dokumen beserta file fisiknya (`delete_document`).
- **Pembuatan DOCX Kaya, XLSX Multi-Sheet, & PDF Native (`Task 3.6`):** Merender inline Markdown (`**bold**`, `*italic*`, `` `code` ``) pada DOCX, membuat workbook XLSX berformula aman (`create_spreadsheet`), serta membuat dokumen PDF multi-halaman siap cetak (`create_pdf` / `create_document(format='pdf')`). Di grup, file otomatis dikirim ke `ctx.chatId` grup asal setelah verifikasi workspace; di DM pribadi wajib melalui persetujuan pemilik (`/approve <id>`).
- **Riset Web Aman:** `web_search` (opsional dengan `TAVILY_API_KEY`) dan `web_fetch` (memblokir IP privat/localhost dan kredensial URL).
- **Memori Hibrida & Proyek:** Pencarian gabungan kemiripan kosinus + leksikal + signifikansi + kebaruan, ekstraksi memori konservatif berbasis sinyal eksplisit, serta manajemen task (`create_task`, `list_tasks`, `update_task`, `complete_task`) dan pengingat (`create_reminder`, `list_reminders`, `cancel_reminder`).

### D. Fitur Native WhatsApp & Hardening Transport (Phase 4 — Task 4.1–4.8)
- **14 Tools Native Outbound & Read WAHA (`src/channels/waha/waha-tools.js`):**
  - *Interaksi Chat Saat Ini (`personal` & `group`, `risk: 'external'`):* reaksi emoji (`react_to_message`), polling native 2–12 opsi unik (`send_poll`), pin lokasi peta (`send_location`), kartu kontak vCard (`send_contact_card`), pratinjau tautan kustom berfilter SSRF (`send_link_preview`), serta koreksi/penghapusan pesan milik Bubu di chat yang sama (`edit_bot_message` & `delete_bot_message` dengan penolakan pesan pengguna masuk `false_*`).
  - *Pengiriman Lintas-Chat Berpersetujuan Pemilik (`personal` DM, `requiresApproval: true`):* selain `send_whatsapp_message` (mendukung `replyTo` & `mentions`) dan `send_whatsapp_file`, kini tersedia `send_whatsapp_poll`, `send_whatsapp_location`, dan `send_whatsapp_contact` yang terintegrasi penuh dengan `/approve <id>` dan `/deny <id>` di `ApprovalManager`.
  - *Inspeksi Terisolasi Scope (`risk: 'low'`):* `get_group_info` khusus workspace grup (`@g.us`) dengan batas maksimum 30 peserta; `check_whatsapp_number`, `get_waha_session_status`, dan `list_recent_chat_messages` (1–15 pesan terbaru tanpa unduh media, ditandai `untrusted: true`) khusus DM personal pemilik.
- **Pemecahan Pesan Panjang Otomatis (`splitWhatsAppMessage`):** `ResponseHandler.sendText` otomatis memecah pesan panjang (`>3800` karakter) secara berurutan pada batas paragraf/baris/kata dengan menjaga keseimbangan blok kode ```` ``` ````, menyertakan `replyTo`/`mentions` hanya pada bagian pertama, serta menandai kegagalan pada bagian ke-`2..N` sebagai `deliveryStatus: 'uncertain'`.
- **Auto-Discovery Identitas Bot (`botJid` & `botLid`) & Normalisasi Vote Polling:** `WahaSessionMonitor.syncFromWaha` menyinkronkan status sesi serta `botJid`/`botLid` saat startup (dengan fallback `getMe()`) secara non-fatal dan memperbaruinya dari payload `me` webhook terautentikasi. `hasBotMention` mengenali daftar JID dan `@lid` bot secara bersamaan, `/status` menampilkan `Bot JID` yang terdeteksi, dan `normalizePollVote` mengekstrak event `poll.vote`.
- **Hardening Transport, Keamanan & Kehadiran WAHA:** Seluruh 13 metode pengiriman/mutasi keluar WAHA terpusat eksklusif di `ResponseHandler` tanpa `fs.readFileSync` pemblokir event-loop. Dilengkapi verifikasi webhook token & HMAC-SHA512 (`crypto.timingSafeEqual`), `sendSeen` terarah (`messageIds` + `participant` di grup), typing keepalive berkala, serta redaksi kredensial di log Pino.

### E. Orkestrasi Agen & Siklus Hidup Memori Lanjutan (Phase 5 — Task 5.1–5.8)
- **Migrasi Skema v11 & Siklus Hidup Memori (`src/db/migrations.js`, `src/db/database.js`, `src/db/repositories/memory.repository.js`):** Menambahkan kolom `status` (`active`, `superseded`, `archived`), `superseded_by`, dan indeks `idx_memories_active_scope`; de-duplikasi konten aktif saat `saveMemory`; pemfilteran status aktif pada pencarian tanpa menimpa `updated_at` saat baca; serta transaksi SQLite atomik pada `beginToolExecution`, `denyApproval`, dan `finishApproval`.
- **12 Tools Memori Terisolasi Workspace (`src/memory/memory-tools.js`, `src/memory/memory-service.js`):** Menambah `list_memories`, `update_memory`, `forget_memory`, dan `consolidate_memories`, serta dukungan `supersedeId` pada `remember_fact` / `captureFromTurn`, parser JSON aman (`extractJsonObject`), deduplikasi permintaan embedding serentak, `backfillEmbeddings`, dan `consolidateWorkspace`.
- **Budget Prompt JSON-Aman & Eskalasi Tier Dinamis (`src/agent/prompt-builder.js`, `src/agent/runtime.js`):** `fitJsonArrayToBudget` memastikan konteks dokumen (`<= 3000`), memori (`<= 6000`), dan proyek (`<= 3000`) selalu berupa JSON array yang valid; `trimHistoryToBudget` menjaga riwayat percakapan terbaru dalam batas karakter (`16000`) dengan mempertahankan atribusi pengirim grup; dan `AgentRuntime` menaikkan tier `fast` ke `balanced` saat putaran lanjutan membutuhkan sintesis hasil tool.
- **Perintah `/memory` & Backfill Oportunistik (`src/agent/command-handler.js`, `src/agent/message-processor.js`):** Menyediakan `/memory status`, `/memory list`, dan `/memory sync` (khusus pemilik) beserta pembaruan `/help`, serta memicu `backfillEmbeddings` secara non-fatal setelah auto-capture memori berhasil.

### F. Desain Ulang Antrean & Pengerasan End-to-End (Phase 6 — Task 6.1–6.8)
- **Migrasi Skema v12 & Antrean Prioritas FIFO Per-Chat (`src/db/migrations.js`, `src/db/database.js`, `src/db/repositories/inbox.repository.js`, `src/app.js`):** Menambahkan kolom `priority` (`1..10`, default `5`) serta indeks `idx_inbox_priority_ready` dan `idx_inbox_chat_status` pada `inbox_events`. `classifyEventPriority` memberi prioritas `1` untuk perintah pemilik (`/approve`, `/deny`, `/status`, `/queue`), `2` untuk DM, dan `5` untuk grup, sementara `claimNextEvent()` atomik menjamin tidak ada dua event dari `chat_id` yang sama berjalan bersamaan.
- **Manajemen Dead-Letter, Retensi Data, & Telemetri (`src/db/repositories/inbox.repository.js`, `src/db/repositories/telemetry.repository.js`):** Menyediakan `getQueueStats`, `listDeadEvents`, `requeueDeadEvent` (menolak requeue untuk event berstatus `uncertain` / `delivery_uncertain:` agar pengiriman ganda tetap terhindar), `pruneHistoryAndQueue` transaksional untuk event `completed`/`dead`, `model_usage`, dan `audit_logs`, serta `getTelemetrySummary`.
- **Konkurensi Multi-Slot Terbatas, Pembersihan Temp, & Perintah `/queue` (`src/workers/inbox-worker.js`, `src/index.js`, `src/agent/command-handler.js`):** `InboxWorker` mendukung `maxConcurrentJobs` (`AGENT_MAX_CONCURRENT_JOBS`), pemangkasan berkala `pruneHistoryAndQueue` (`pruneIntervalMs`), dan `getStats()`; `cleanupStaleTempDirs` membersihkan direktori sementara `bubu-*` yang kedaluwarsa saat startup (melindungi `bubu-db-*` dan direktori baru); dan `/queue` (`/queue status`, `/queue dead`, `/queue retry <eventId>`, `/queue prune`) memberi kendali antrean bagi pemilik.
- **Pengerasan Backup Produksi (`scripts/backup.js`):** `runBackup` memvalidasi keberadaan DB sumber, menolak jalur `backupDir` dan `storageDir` yang identik atau bersarang satu sama lain, membuka DB dengan `{ readonly: true, fileMustExist: true, timeout: 10000 }`, menulis ke `.tmp`, memverifikasi `PRAGMA integrity_check === 'ok'`, mengatur izin `0o600`, melakukan rename atomik, menyalin `storageDir`, dan memutar cadangan lama melalui `pruneOldBackups(backupDir, keepCount)`.
- **Pembungkusan Token Panjang PDF & Normalisasi Sel XLSX/CSV (`src/documents/generators/pdf-generator.js`, `src/documents/document-service.js`):** `splitOversizedToken` dan `wrapTextToWidth` memastikan tidak ada baris/URL yang melebihi batas lebar, dan tabel Markdown `buildPdf14Buffer` membungkus sel hingga 4 baris dengan tinggi baris dinamis (`Math.max(20, maxCellLines * 11 + 8)`). Ekstraksi spreadsheet menormalisasi `richText`, `Date` (ISO), `error`, hasil formula, baris baru (`\r?\n`), dan karakter pipa (`|` → `│`) agar kolom `spreadsheet-analyzer.js` tetap presisi.

### G. Observatorium Pipeline 3D Real-Time & Telemetri SSE (`waha.andresptr.site`)
- **Telemetri Read-Only & Sanitasi Privasi (`src/telemetry/pipeline-events.js`, `src/app.js`, `src/db/repositories/telemetry.repository.js`):** `PipelineEventBus` mengelola ring buffer bounded dan menyiarkan event live terstruktur ke `GET /api/visualizer/snapshot` dan `GET /api/visualizer/stream` (SSE). Seluruh payload disanitasi ketat: identitas chat dianonimkan menjadi `DM-xxxx` / `GRP-xxxx` tanpa teks WhatsApp mentah, JID/nomor telepon, argumen tool, atau estimasi biaya, serta mendukung pembatasan klien SSE (`VISUALIZER_MAX_SSE_CLIENTS`) dan token opsional (`VISUALIZER_ACCESS_TOKEN`).
- **Observatorium 3D Kantor Futuristik & Padang Rumput (`web/`, `scripts/deploy-web.sh`, `deploy/`):** Aplikasi React + TypeScript + Vite + Three.js yang di-deploy ke `https://waha.andresptr.site`:
  - *Arsitektur Eksterior & Ruang:* Paviliun futuristik dua tingkat dengan teras batu, dua kolam pantul depan, jembatan masuk berundak, kanopi kaca portal samping, dinding tirai kaca panorama di fasad belakang, mahkota atap logam dengan 9 rusuk eksoskeleton C-frame dan panel surya, serta padang rumput berbukit 3D (`web/src/scene/meadowEnvironment.ts`) lengkap dengan rumput instanced, pepohonan, semak, dan batu alam.
  - *Zoning 8 Ruangan & Interior:* Lantai terzonasi per stasiun (lobby terrazzo, raised-access floor teknis, lab akustik, arsip kayu hangat, dan Command Rotunda `Inti AI`), koridor jalur fiber-optic berlapis kaca, partisi kaca ber-celah kabel, konsol pembatas kantilever, lounge & huddle sayap kiri-kanan, serta dukungan tema Gelap/Terang.
  - *Kontrol Interaktif & Aksesibilitas:* Mode `Live WhatsApp` (SSE) dan `Simulasi` 1-baris ringkas, preset kamera (`Ikuti`, `Panorama`, `Inti AI`), panel `Inspektor Pipeline` responsif, fallback WebGL 2D, dan favicon seragam dengan `andresptr.site`.

---

## 6. Struktur Direktori Proyek

```text
bubu-ai/
├── data/                                   # Database SQLite lokal (bubu.sqlite, WAL/SHM — gitignored)
├── deploy/                                 # Konfigurasi referensi OpenResty vhost, proxy /api/visualizer, & header keamanan
├── scripts/                                # Skrip operasional, build/deploy web, cek sintaks, & regresi otomatis
│   ├── backup.js                           # Online backup SQLite terverifikasi integrity_check + rotasi storage
│   ├── check-syntax.js                     # Pemeriksaan sintaks seluruh file JS/CJS
│   ├── deploy-web.sh                       # Typecheck, build web/, & sync statis ke waha.andresptr.site
│   ├── list-models.js                      # Cek katalog model Sumopod
│   ├── phase1-regression.sh                # Gate regresi otomatis Phase 1
│   ├── phase2-regression.sh                # Gate regresi otomatis Phase 2
│   ├── phase3-regression.sh                # Gate regresi otomatis Phase 3
│   ├── phase4-regression.sh                # Gate regresi otomatis Phase 4
│   ├── phase5-regression.sh                # Gate regresi otomatis Phase 5
│   ├── phase6-regression.sh                # Gate regresi otomatis Phase 6
│   └── smoke-tool-calling.js               # Uji smoke tool calling
├── src/
│   ├── agent/                              # Orkestrasi agen (Runtime, PromptBuilder, CommandHandler, MessageProcessor, ModelRouter, ApprovalManager, ToolRegistry)
│   ├── channels/                           # Transport & formatting WhatsApp (ResponseHandler, WhatsAppFormatter, WAHA Client, Normalizer, SessionMonitor & Tools)
│   ├── config/                             # Konfigurasi environment & default produksi (env.js)
│   ├── db/                                 # DatabaseStore, migrasi v1–v12 (migrations.js), dan 7 repository SQLite per domain (repositories/)
│   ├── documents/                          # Layanan & tools dokumen (DocumentService, DocumentTools, parsers/, generators/)
│   ├── media/                              # Layanan & validasi multimodal (MediaIntelligenceService, media-validator.js)
│   ├── memory/                             # Memori semantik & proyek (MemoryService, memory-tools.js)
│   ├── productivity/                       # Tools task, reminder, & pengiriman pesan DM tervalidasi (productivity-tools.js)
│   ├── providers/                          # SumopodProvider (OpenAI-compatible + image_url sanitizer)
│   ├── telemetry/                          # PipelineEventBus & sanitasi payload telemetri visualizer (pipeline-events.js)
│   ├── utils/                              # Utilitas bersama (error-policy, media-http, model-pricing, process-runner, rate-limiter, vector, zod-loader)
│   ├── web/                                # Pencarian & fetch web aman (WebSearchService, WebFetchService, web-tools.js)
│   ├── workers/                            # Background worker (InboxWorker, ReminderWorker)
│   ├── app.js                              # Server HTTP Fastify (/webhook, /health, /ready, /api/visualizer/*)
│   └── index.js                            # Bootstrap aplikasi & graceful shutdown
├── storage/                                # Penyimpanan privat dokumen & media sementara (isi gitignored)
├── test/
│   ├── contracts/                          # Kontrak regresi lintas-fase (phase1, phase2, phase4, phase5, & phase6)
│   ├── integration/                        # Tes integrasi SQLite & migrasi (database.test.js)
│   └── unit/                               # Unit test per domain (agent, channels, config, documents, media, memory, telemetry, utils, web, workers)
│       ├── channels/app-visualizer.test.js
│       ├── telemetry/pipeline-events.test.js
│       └── utils/model-pricing.test.js
└── web/                                    # Frontend Observatorium Alur 3D (React + TypeScript + Vite + Three.js)
    ├── public/                             # Aset favicon & apple-touch-icon (sinkron dengan andresptr.site)
    └── src/
        ├── components/                     # TopBar, InspectorPanel, SimulationControls, StageStepper, WebGLFallback, Icons
        ├── data/                           # Definisi 8 stasiun (stages.ts) & skenario simulasi (simulations.ts)
        ├── hooks/                          # Stream SSE & state simulasi (useVisualizerStream.ts)
        ├── scene/                          # PipelineScene, officeEnvironment, meadowEnvironment, stations, conduits, packets, materials
        ├── styles/                         # Token warna & layout responsif (tokens.css, app.css)
        └── types/                          # Tipe TypeScript pipeline & telemetri (pipeline.ts)
```

---

## 7. Perintah Operasional & Pengujian

```bash
# 1. Backup SQLite + storage sebelum update
npm run backup

# 2. Jalankan cek sintaks seluruh JS/CJS + semua test suite (unit, integration, contract)
npm run check

# 3. Jalankan suite tes spesifik
npm run test:unit
npm run test:integration
npm run test:contracts

# 4. Typecheck, build, & deploy frontend Observatorium 3D (waha.andresptr.site)
cd web && npx tsc --noEmit && npm run build
bash scripts/deploy-web.sh

# 5. Jalankan gate regresi Phase 1–6 di VPS
npm run test:phase1
npm run test:phase2
npm run test:phase3
npm run test:phase4
npm run test:phase5
npm run test:phase6

# 6. Restart layanan melalui PM2 & cek kesehatan
pm2 restart bubu
curl -s http://127.0.0.1:3088/health
curl -s http://127.0.0.1:3088/ready
```
