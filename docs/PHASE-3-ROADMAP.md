# Bubu v2.4.0 — Roadmap dan Task Phase 3 (Document Intelligence Mendalam)

8 November 2026 · Handover & Rencana Kerja Phase 3 (Diadaptasi dari Roadmap 6-Fase Bubu v2.4.0)

**Phase 1 — Core Reliability & Response Control** sudah selesai dan disetujui pemilik.  
**Phase 2 — Full Multimodal WhatsApp** sudah selesai pada sisi implementasi kode & suite regresi unit lokal (`203/203` tes lulus), menunggu penutupan gate rilis VPS oleh pemilik.  
**Phase 3 — Deep Document Intelligence** kini dirancang untuk membawa kemampuan baca, OCR dokumen scan, analisis struktur halaman/sheet, pembuatan/ekspor dokumen profesional, dan manajemen siklus hidup dokumen ke standar produksi di DM dan grup.  
**Phase 4** (Pengiriman Native WhatsApp Baru), **Phase 5** (Agent & Memory Lanjutan), dan **Phase 6** (Redesign Antrean & Hardening Menyeluruh) tetap berada pada fase berikutnya.

---

## Mulai di sesi baru

Gunakan prompt berikut bila memulai pengerjaan Phase 3 di sesi baru:

> Bertindak sebagai Senior AI Engineer dan Technical Lead untuk Bubu. Baca `docs/PHASE-3-ROADMAP.md`, `docs/PHASE-2-ROADMAP.md`, dan `docs/P1-ADVANCED-AGENT-TOOLS.md`. Pertahankan seluruh kontrak Phase 1 dan Phase 2 yang sudah disetujui (isolasi DM vs grup, `ResponseHandler`, voice-only fail-closed, approval DM, auto-delivery grup ke `ctx.chatId`, uncertain delivery non-retry, dan kebijakan minimal `.env` dengan default di `src/config/env.js`). Kerjakan Phase 3 secara bertahap mulai dari Task 3.1 hingga Task 3.8.

---

## 1. Baseline source, VPS, dan gap analisis Document Intelligence saat ini

| Area | Kondisi saat ini (pasca Phase 2) | Keterbatasan / Gap untuk Phase 3 | Implikasi arsitektur Phase 3 |
|---|---|---|---|
| **Build & Konfigurasi** | Bubu **2.4.0**, Node **v24.22.1**, SQLite schema **v9**, `.env` minimal (seluruh default model, STT/TTS, dan Vision ada di `src/config/env.js`). | Semua konfigurasi baru Phase 3 wajib memiliki default aman di `src/config/env.js` tanpa menambah variabel wajib di `.env`. | Pertahankan kebijakan minimal `.env`. |
| **Kapasitas VPS** | **2 vCPU**, **1,9 GiB RAM total**, **23,7 GiB disk bebas**. | Render halaman PDF scan atau parsing XLSX besar berisiko memicu lonjakan RAM jika dijalankan paralel dengan Whisper/FFmpeg. | Gunakan batas halaman OCR PDF (mis. maks 10–15 halaman per dokumen) dan single-concurrency guard (`docOcrBusy` / berbagi antrean berat). |
| **Ingesti PDF (`src/p1/documents/service.js`)** | Menggunakan `pdf-parse` untuk ekstraksi teks satu blok utuh (`extracted_text`), dipotong pada `maxExtractChars` (`50.000` karakter). | 1) PDF hasil scan / gambar-saja gagal total (*"teks tidak dapat diekstrak"*). 2) Tidak ada pemisahan nomor halaman (`Halaman N`), sehingga dokumen panjang kehilangan konteks posisi dan halaman akhir terpotong. | **Task 3.2 & 3.3:** Ekstraksi per halaman + fallback OCR/Vision terukur untuk PDF scan/hybrid. |
| **Ingesti DOCX (`mammoth`)** | `mammoth.extractRawText()` mengekstrak teks polos tanpa struktur heading atau batas tabel. | Tabel dan hierarki bagian di dalam DOCX menyatu menjadi baris teks biasa sehingga sulit dirujuk per bagian/tabel. | **Task 3.3:** Pertahankan struktur heading, daftar, dan tabel Markdown saat ekstraksi DOCX. |
| **Ingesti & Analisis Spreadsheet (`exceljs`, CSV)** | Mengekstrak seluruh baris sebagai string `rowNumber: col1 \| col2` hingga `50.000` karakter; `analyze_spreadsheet` hanya mengembalikan dump teks mentah. | 1) CSV belum menangani quoting kompleks/delimiter `;` (umum di Excel Indonesia) secara terstruktur. 2) Belum ada profil skema kolom, tipe data, dan agregasi deterministik (`sum`, `avg`, `min`, `max`, `count`, filter) di sisi server, sehingga model rawan salah hitung pada ribuan baris. | **Task 3.4:** Mesin analitik tabel/spreadsheet deterministik untuk `analyze_spreadsheet`. |
| **Pencarian & Pembacaan (`read_document`, `search_document`)** | `read_document` hanya mengembalikan teks awal dokumen; `search_document` hanya menghitung kemunculan kata dan memotong `1.800` karakter pertama dokumen (`extracted_text.slice(0, 1800)`), **bukan** cuplikan di sekitar kata kunci! | Jika kata kunci ada di halaman 12 (karakter ke-30.000), `search_document` tetap mengembalikan halaman 1 sehingga model tidak pernah melihat bagian yang relevan. | **Task 3.3 & 3.5:** Chunking berbasis halaman/bagian + window snippet di sekitar kecocokan kata kunci + navigasi halaman/rentang pada `read_document`. |
| **Kutipan (Reply/Quote) Dokumen** | Pada Phase 2 (Task 2.4), quote memberikan metadata pesan yang di-reply, tetapi jika pengguna me-reply pesan dokumen lama di chat yang sama, Bubu belum otomatis menghubungkan ke record `documents` di workspace chat tersebut. | Pengguna harus menyebutkan ulang nama/ID dokumen atau meminta `list_documents` terlebih dahulu. | **Task 3.5:** Resolusi dokumen dari konteks chat/quote same-chat (`source_event_id` / filename) dengan tetap menolak quote lintas chat. |
| **Pembuatan Dokumen (`create_document`, `create_spreadsheet`)** | Mendukung 16 tipe DOCX dan 8 tipe XLSX dengan validasi formula berbahaya dan pengiriman aman (DM approval, Grup auto-send ke `ctx.chatId`). | 1) Markdown inline (`**bold**`, `*italic*`, `` `code` ``) di dalam paragraf/sel tabel DOCX belum di-parse menjadi `TextRun` berformat (masih tercetak literal `**teks**`). 2) Belum mendukung pembuatan/ekspor laporan **PDF** siap cetak. | **Task 3.6:** Inline rich-text formatting pada DOCX, peningkatan tata letak tabel/ringkasan XLSX, dan dukungan pembuatan/ekspor PDF yang tunduk pada kontrak pengiriman Phase 1. |
| **Manajemen & Retensi Storage (`src/db/database.js`)** | File disimpan di `storage/` dan `storage/generated/`; terdapat duplikasi definisi metode `saveDocument`, `getDocument`, `listDocuments`, `searchDocuments`, `createUserTask`, `getUserTask`, `listUserTasks`, `updateUserTask`, `listReminders` di `src/db/database.js`. | Belum ada tool penghapusan/pembersihan dokumen per workspace (`delete_document`) maupun kebijakan retensi/kuota storage, serta perlu pembersihan kode duplikat di `database.js`. | **Task 3.7:** Deduplikasi metode `database.js`, manajemen dokumen workspace, dan guard kuota/retensi. |

---

## 2. Cakupan dan kontrak yang wajib dipertahankan (Phase 1 & Phase 2)

Setiap perubahan pada Phase 3 **wajib** mematuhi kontrak berikut tanpa pengecualian:

1. **Isolasi Workspace & Ingress.**
   - Dokumen DM bersifat `scope='personal'` (hanya milik `OWNER_JID`, `chat_id = NULL`).
   - Dokumen grup bersifat `scope='group'` (`owner_id = NULL`, `chat_id = <group_jid>@g.us`).
   - Dokumen dari Grup A tidak boleh terlihat, dicari, dibaca, diringkas, atau dikirim ke Grup B maupun ke DM pribadi.
   - Gate mention grup (`GROUP_REQUIRE_MENTION=true`) dan kebijakan media-only (`GROUP_MEDIA_REQUIRE_MENTION=false`) tetap berlaku.
2. **Keamanan Konten & Anti-Prompt Injection.**
   - Seluruh isi dokumen (teks PDF/DOCX/XLSX/CSV/TXT maupun hasil OCR halaman scan) berstatus `[UNTRUSTED_ATTACHMENT_EVIDENCE]` / data tidak tepercaya.
   - Instruksi di dalam dokumen tidak boleh mengubah aturan sistem, mengubah scope chat, memicu tool eksternal tanpa instruksi eksplisit pengguna saat ini, melewati approval pemilik, atau memicu auto-memory capture.
3. **Kontrak Pengiriman File & Mode Balasan.**
   - Seluruh pengiriman pesan dan file keluar wajib melalui `ResponseHandler`.
   - File yang dibuat di **grup** hanya boleh dikirim otomatis ke `ctx.chatId` grup asal setelah verifikasi ulang record DB `(id, scope='group', chat_id)` dan validasi path di dalam `storageDir`.
   - File yang dibuat di **DM pribadi** tetap wajib melalui `ApprovalManager` (`/approve <id>` atau `/deny <id>`).
   - Kegagalan pengiriman WAHA ditandai `deliveryStatus='uncertain'` dan **tidak pernah** dikirim ulang otomatis.
   - Mode `/voice on` (voice-only fail-closed), `/voice both`, `/voice off`, `/voice status`, dan `/voice reset` tetap dihormati untuk balasan asisten dan notifikasi error.
4. **Kebijakan Minimal `.env`.**
   - Semua pengaturan baru Phase 3 (batas halaman OCR PDF, ukuran chunk dokumen, tool binary lokal jika ada) wajib memiliki nilai default produksi di `src/config/env.js` sehingga `.env` di VPS tidak perlu diubah.

---

## 3. Urutan pengerjaan dan rincian Task Phase 3

| Task | Fokus utama | Target modul utama | Output / Bukti |
|---|---|---|---|
| **Task 3.1** | Audit kapabilitas tool PDF/dokumen di VPS & desain skema chunk/metadata | `scripts/`, `docs/` | Laporan inventaris biner VPS (`pdftoppm`/`ghostscript`/`libreoffice`/FFmpeg) & keputusan arsitektur |
| **Task 3.2** | OCR & Vision fallback untuk PDF hasil scan / image-only / hybrid | `src/p1/documents/service.js`, `src/p3/media/service.js`, `src/config/env.js` | PDF scan & hybrid berhasil diekstrak dengan label sumber halaman (`[PAGE_OCR]` / `[PAGE_TEXT]`) |
| **Task 3.3** | Ekstraksi terstruktur, penomoran halaman/bagian, & pencarian snippet kontekstual | `src/p1/documents/service.js`, `src/db/database.js`, `src/p1/tools.js` | `read_document` mendukung rentang halaman/bagian; `search_document` mengembalikan cuplikan tepat di sekitar kata kunci |
| **Task 3.4** | Analitik Spreadsheet & CSV deterministik (multi-sheet, delimiter, statistik, filter) | `src/p1/documents/service.js`, `src/p1/tools.js` | `analyze_spreadsheet` menghitung `sum/avg/min/max/count`, profil kolom, & filter baris secara akurat |
| **Task 3.5** | Konteks dokumen multi-turn, resolusi reply/quote dokumen same-chat, & perbandingan dokumen | `src/agent/message-processor.js`, `src/agent/runtime.js`, `src/p1/tools.js` | Reply ke pesan dokumen di chat yang sama otomatis terhubung ke dokumen tersebut; tool `compare_documents` |
| **Task 3.6** | Peningkatan generator dokumen (inline Markdown DOCX, tabel kaya, & pembuatan PDF) | `src/p1/documents/service.js`, `src/p1/tools.js` | DOCX merender `**bold**`/`*italic*`/`` `code` `` dengan rapi; dukungan pembuatan dokumen PDF dengan approval DM / auto-send grup |
| **Task 3.7** | Siklus hidup dokumen, deduplikasi `database.js`, & tata kelola storage workspace | `src/db/database.js`, `src/p1/documents/service.js`, `src/p1/tools.js` | Deduplikasi kode `database.js`, tool `delete_document`, perlindungan kuota & pembersihan file yatim |
| **Task 3.8** | Regresi penuh Phase 1–3, uji performa VPS, & matriks acceptance WhatsApp | `test/unit/`, `scripts/phase3-regression.sh`, `docs/` | Skrip `scripts/phase3-regression.sh` lulus, `npm test` lulus, dan matriks acceptance WhatsApp DM & grup |

---

## 4. Rincian setiap Task

### Task 3.1 — Audit prasyarat dokumen di VPS & pembekuan desain
- [ ] **3.1A · Inventaris biner konversi/render halaman PDF di VPS.** Periksa ketersediaan utilitas CLI lokal di VPS (`/www/wwwroot/bot-project/bubu`), seperti `pdftoppm` (`poppler-utils`), `pdftotext`, `gs` (Ghostscript), atau `soffice` (LibreOffice) bersama `ffmpeg` dan `tesseract` yang sudah terpasang.
- [ ] **3.1B · Evaluasi jejak resource (CPU/RAM) pada VPS 2 vCPU / 1,9 GiB.** Ukur penggunaan memori saat merender 1–10 halaman PDF scan ke citra 150–200 DPI dan menjalankan Tesseract OCR (`ind+eng`) + opsional Sumopod Vision (`claude-sonnet-5-5`).
- [ ] **3.1C · Pembekuan desain skema & batas aman.** Tetapkan apakah penyimpanan halaman/section menggunakan struktur terindeks pada tabel `documents` / `document_chunks` (migrasi SQLite v10 yang backward-compatible) atau metadata JSON terstruktur, serta kunci batas default di `src/config/env.js` (mis. `maxPdfOcrPages = 10`, `pdfRenderDpi = 150`).

### Task 3.2 — Pemahaman PDF hasil scan, gambar-saja, dan hybrid
- [ ] **Deteksi kepadatan teks per halaman.** Saat meng-ingest PDF, periksa apakah teks hasil ekstraksi kosong atau sangat minim (mis. rata-rata `< 25` karakter/halaman atau halaman tertentu hanya berisi gambar scan).
- [ ] **Pipeline OCR & Vision halaman PDF terukur.**
  - Render halaman yang tidak memiliki lapisan teks menjadi gambar JPEG terukur di direktori kerja sementara (`os.tmpdir()`), dibatasi maksimal `maxPdfOcrPages` halaman per dokumen.
  - Jalankan Tesseract OCR (`ind+eng`) per halaman dan, bila diperlukan untuk halaman berdiagram/tabel visual, dukung ringkasan visual terukur melalui model vision (`claude-sonnet-5-5`) dengan menjaga batas `maxVisionBytes`.
  - Beri penanda eksplisit per halaman (`[Halaman 1 — Teks Asli]`, `[Halaman 2 — OCR Scan]`) dan cantumkan catatan jujur apabila jumlah halaman dokumen melebihi batas halaman OCR (`maxPdfOcrPages`).
- [ ] **Single-concurrency & cleanup ketat.** Lindungi proses render/OCR PDF dengan concurrency guard agar tidak bertabrakan dengan job STT/Video di VPS 1,9 GiB RAM, dan hapus seluruh file gambar halaman sementara di blok `finally`.

### Task 3.3 — Ekstraksi terstruktur & pencarian dokumen berbasis cuplikan kontekstual
- [ ] **Penomoran halaman & struktur bagian.**
  - Simpan batas halaman pada PDF (`--- [HALAMAN N] ---`) dan struktur heading (`#`, `##`, `###`), bullet list, serta tabel pipa pada ekstraksi DOCX sehingga informasi tata letak tidak hilang.
  - Tingkatkan batas penyimpanan teks dokumen dan sediakan metadata ringkas (`pageCount`, `charCount`, `hasOcrPages`, `sheetNames` untuk spreadsheet).
- [ ] **Perbaikan `search_document` (Contextual Snippet Search).**
  - Ganti perilaku lama (`extracted_text.slice(0, 1800)`) dengan pencarian berbasis segmen/halaman yang mengembalikan **cuplikan tepat di sekitar lokasi kata kunci ditemukan** beserta nomor halaman/bagian dan skor kecocokan.
- [ ] **Peningkatan `read_document` (Paginated / Section Read).**
  - Tambahkan parameter opsional `page` / `startPage`–`endPage` atau `offset`–`limit` pada tool `read_document` agar Agent dapat membaca halaman spesifik pada dokumen panjang (mis. halaman 15–18 dari laporan 40 halaman) tanpa kehilangan bagian akhir dokumen.

### Task 3.4 — Analitik Spreadsheet & CSV deterministik (`analyze_spreadsheet`)
- [ ] **Parser CSV tangguh.** Dukung deteksi otomatis delimiter (`,`, `;`, `\t`), quoted fields multi-baris, BOM UTF-8, dan normalisasi angka format Indonesia/internasional (`1.250.000,50` vs `1,250,000.50`).
- [ ] **Mesin komputasi & profil tabel di sisi server.**
  - Saat `analyze_spreadsheet` dipanggil, selain mengembalikan sampel baris, kembalikan juga:
    1. Daftar nama sheet, jumlah baris, dan daftar kolom beserta tipe datanya (`numeric`, `text`, `date`, `formula`, `empty`).
    2. Statistik agregat deterministik otomatis untuk kolom numerik (`count`, `sum`, `min`, `max`, `avg`) per sheet.
    3. Dukungan parameter opsional pada `analyze_spreadsheet`: `sheetName`, `filterColumn`, `filterValue`, `groupByColumn`, `aggregateColumn`, dan `rowLimit` sehingga Agent tidak perlu menebak jumlah/rata-rata secara manual dari teks terpotong.

### Task 3.5 — Konteks dokumen multi-turn, kutipan (reply) dokumen, & perbandingan dokumen
- [ ] **Resolusi reply/quote ke pesan dokumen di chat yang sama.**
  - Jika pengguna me-reply pesan dokumen (atau pesan balasan asisten atas dokumen) di dalam chat yang sama (`quoteContext.present` dan tidak `rejected`), hubungkan otomatis ke dokumen workspace yang sesuai di chat tersebut sehingga instruksi seperti *"Ringkas poin ke-3 dari file ini"* atau *"Berapa total di sheet kedua?"* langsung mengetahui `documentId` target.
  - Pertahankan penolakan keras terhadap quote lintas chat (`quote.rejected = true`).
- [ ] **Tool `compare_documents` (Perbandingan 2 dokumen dalam workspace yang sama).**
  - Sediakan kemampuan membandingkan dua dokumen di dalam workspace yang sama (mis. revisi kontrak v1 vs v2, atau anggaran Q1 vs Q2) dengan memastikan kedua `documentId` diverifikasi milik `(scope, ownerId/chatId)` yang sama.
- [ ] **Kepatuhan memori.** Pastikan giliran yang melibatkan lampiran dokumen atau quote dokumen tetap melewati automatic memory extraction kecuali pengguna memberi perintah eksplisit untuk menyimpan fakta.

### Task 3.6 — Peningkatan pembuatan dokumen (Rich DOCX, XLSX lanjutan, & ekspor PDF)
- [ ] **Inline Markdown parsing pada generator DOCX (`createDocx`).**
  - Parse sintaks inline `**teks tebal**`, `*teks miring*`, dan `` `kode` `` di dalam paragraf, daftar bullet/nomor, kutipan, dan sel tabel menjadi `TextRun` dengan properti `bold`, `italics`, dan font monospace, sehingga dokumen Word yang dihasilkan bersih tanpa simbol bintang mentah.
- [ ] **Peningkatan `create_spreadsheet`.**
  - Dukung baris ringkasan/total terformat otomatis dan validasi referensi lintas sheet yang aman, sambil tetap mempertahankan blokir penuh terhadap formula berbahaya (`HYPERLINK`, `WEBSERVICE`, `RTD`, `DDE`, `CALL`, `REGISTER.ID`, `EXEC`, referensi workbook eksternal).
- [ ] **Dukungan pembuatan / ekspor dokumen PDF (`format: 'docx' | 'pdf'` atau `create_pdf`).**
  - Dukung pembuatan dokumen PDF profesional (proposal, invoice, quotation, surat resmi, laporan) dan simpan di workspace aktif (`.pdf`, `application/pdf`).
  - Terapkan kontrak pengiriman yang identik dengan DOCX/XLSX:
    - Di **grup**: verifikasi record `(id, scope='group', chat_id=ctx.chatId)`, validasi path di dalam `storageDir`, lalu kirim otomatis hanya ke `ctx.chatId` melalui `ResponseHandler.sendFile`; bila WAHA timeout, tandai `deliveryStatus='uncertain'` tanpa retry otomatis.
    - Di **DM pribadi**: buat permintaan approval pemilik melalui `ApprovalManager`.

### Task 3.7 — Manajemen siklus hidup dokumen, deduplikasi `database.js`, & tata kelola storage
- [ ] **Pembersihan duplikasi metode di `src/db/database.js`.**
  - Hapus definisi metode ganda (`saveDocument`, `getDocument`, `listDocuments`, `searchDocuments`, `createUserTask`, `getUserTask`, `listUserTasks`, `updateUserTask`, `listReminders`) di `src/db/database.js` agar hanya ada satu implementasi kanonik yang bersih dan konsisten.
- [ ] **Tool manajemen dokumen workspace (`delete_document`).**
  - Sediakan tool untuk menghapus dokumen dari workspace aktif (menghapus baik record SQLite maupun file fisik di `storage/`) dengan validasi kepemilikan `(scope, ownerId/chatId)` dan pencatatan di `audit_logs`.
- [ ] **Perlindungan storage & pembersihan file yatim.**
  - Pastikan kegagalan ekstraksi, kegagalan simpan DB, atau pembatalan tidak meninggalkan file yatim di `storage/`, dan sediakan pengecekan integritas direktori dokumen.

### Task 3.8 — Regresi penuh Phase 1–3, performa VPS, dan acceptance WhatsApp
- [ ] **Unit & integration test baru Phase 3.**
  - `test/unit/document-ocr-pdf.test.js` (Task 3.2: PDF scan, hybrid, batas halaman, cleanup, concurrency guard).
  - `test/unit/document-structured-search.test.js` (Task 3.3: ekstraksi per halaman, DOCX terstruktur, snippet search di halaman tengah/akhir, paginated read).
  - `test/unit/spreadsheet-analytics.test.js` (Task 3.4: CSV `;`/quoted, statistik deterministik `sum/avg/min/max/count`, filter sheet).
  - `test/unit/document-context-compare.test.js` (Task 3.5: quote dokumen same-chat, blokir quote lintas chat, `compare_documents` isolasi workspace).
  - `test/unit/document-generation-v3.test.js` (Task 3.6 & 3.7: inline Markdown DOCX, pembuatan & pengiriman PDF DM/grup, `delete_document`).
  - `test/unit/phase3-regression-contract.test.js` & `scripts/phase3-regression.sh`.
- [ ] **Verifikasi penuh di VPS.**
  - Jalankan `npm test`, `npm run test:phase1`, `bash scripts/phase2-regression.sh`, dan `bash scripts/phase3-regression.sh` di VPS (`/www/wwwroot/bot-project/bubu`).
- [ ] **Matriks acceptance WhatsApp langsung (DM Pemilik, Grup A, Grup B):**
  1. Kirim PDF teks multi-halaman (>10 halaman) -> tanya isi di halaman akhir -> Bubu menemukan dan mengutip halaman yang tepat.
  2. Kirim PDF hasil scan (tanpa teks digital) -> Bubu berhasil menjalankan OCR halaman dan menjelaskan isinya.
  3. Kirim file XLSX multi-sheet & CSV ber-delimiter `;` -> tanya total/rata-rata kolom tertentu -> Bubu menghitung akurat menggunakan `analyze_spreadsheet`.
  4. Reply ke pesan dokumen sebelumnya di DM dan Grup A -> Bubu memahami dokumen yang dimaksud tanpa tertukar.
  5. Minta pembuatan DOCX (dengan teks bold/tabel), XLSX, dan PDF di DM (uji alur `/approve`) serta di Grup A (uji auto-delivery ke Grup A).
  6. Uji isolasi Grup A vs Grup B -> pastikan dokumen yang diunggah atau dibuat di Grup A tidak pernah bisa dicari, dibaca, dibandingkan, atau dikirim di Grup B maupun DM.

---

## 5. Prosedur setiap patch dan penutupan fase

1. **Sebelum deploy.** Pemilik memverifikasi hash file target dan menyimpan backup source serta SQLite (`npm run backup`).
2. **Kebijakan konfigurasi.** Pertahankan `.env` tetap minimal; seluruh nilai default baru wajib berada di `src/config/env.js`.
3. **Deploy oleh pemilik.** Terapkan overlay file yang berubah tanpa menimpa `.env`, `data/`, atau `storage/`. Jalankan `node --check`, `npm test`, `npm run test:phase1`, `bash scripts/phase2-regression.sh`, dan `bash scripts/phase3-regression.sh`.
4. **Rollback.** Kembalikan file source yang dicadangkan (dan backup SQLite bila ada migrasi skema) lalu restart PM2 jika ditemukan regresi.
5. **Tutup task berdasarkan bukti.** Gunakan format `task | build | skenario | DM/grup | hasil | durasi/kategori | konfirmasi pemilik`.

**Phase 3 lulus** setelah seluruh suite regresi Phase 1, Phase 2, dan Phase 3 lulus di VPS serta pemilik mengonfirmasi matriks acceptance dokumen (PDF teks panjang, PDF scan OCR, analitik XLSX/CSV, reply dokumen same-chat, pembuatan DOCX/XLSX/PDF, dan isolasi workspace DM/grup) pada WhatsApp nyata.
