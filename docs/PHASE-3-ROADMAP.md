# Bubu v2.4.0 — Roadmap dan Task Phase 3 (Document Intelligence Mendalam)

8 November 2026 · Handover & Rencana Kerja Phase 3 (Diadaptasi dari Roadmap 6-Fase Bubu v2.4.0)

**Phase 1 — Core Reliability & Response Control** sudah selesai dan disetujui pemilik.  
**Phase 2 — Full Multimodal WhatsApp** sudah selesai pada sisi implementasi kode & suite regresi unit lokal, menunggu penutupan gate rilis VPS oleh pemilik.  
**Phase 3 — Deep Document Intelligence** kini **selesai diimplementasikan pada kode & suite regresi unit lokal (`217/217` tes lulus di 29 suite)**, mencakup OCR otomatis untuk PDF scan/hybrid, ekstraksi DOCX terstruktur, pencarian snippet kontekstual & pembacaan per halaman, analitik spreadsheet/CSV deterministik, resolusi reply/quote dokumen same-chat, `compare_documents`, pembuatan PDF native & inline Markdown DOCX, serta `delete_document` dan deduplikasi `database.js`. Menunggu verifikasi VPS dan acceptance WhatsApp langsung oleh pemilik.  
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
- [x] **3.1A · Rantai fallback renderer halaman PDF di VPS.** `DocumentService.renderPdfPagesToImages` mendukung rantai fallback otomatis `pdftoppm` (`poppler-utils`) -> `gs` (`Ghostscript`) -> `ffmpeg` (sudah terverifikasi aktif di VPS v6.1.1) bersama `tesseract` (`v5.3.4`, `ind+eng`).
- [x] **3.1B · Perlindungan resource (CPU/RAM) pada VPS 2 vCPU / 1,9 GiB.** Dilengkapi single-concurrency guard `this.ocrBusy` pada `DocumentService`, batas default `maxPdfOcrPages = 10`, dan resolusi render `pdfRenderDpi = 150`.
- [x] **3.1C · Pembekuan desain skema & batas aman.** Seluruh konfigurasi default Phase 3 (`ocrEnabled`, `maxPdfOcrPages`, `pdfRenderDpi`, `pdftoppmBin`, `ghostscriptBin`) ditempatkan langsung di `src/config/env.js` agar `.env` di VPS tetap minimal.

### Task 3.2 — Pemahaman PDF hasil scan, gambar-saja, dan hybrid
- [x] **Deteksi kepadatan teks per halaman.** `parsePdfDigitalPages` mengekstrak teks per halaman dan mendeteksi halaman dengan teks kosong/minim (`< 20` karakter).
- [x] **Pipeline OCR halaman PDF terukur (`ocrPdfPages`).**
  - Merender halaman scan/minim teks ke gambar sementara di `os.tmpdir()`, dibatasi maksimal `maxPdfOcrPages` (`10`) halaman per dokumen.
  - Menjalankan Tesseract OCR (`ind+eng`) hanya pada halaman yang membutuhkan OCR, dan mempertahankan teks digital asli pada halaman yang sudah memiliki teks.
  - Memberi penanda eksplisit per halaman (`--- [HALAMAN N — TEKS ASLI] ---`, `--- [HALAMAN N — OCR SCAN] ---`) serta catatan jujur apabila jumlah halaman dokumen melebihi `maxPdfOcrPages`.
- [x] **Single-concurrency & cleanup ketat.** Dilindungi `this.ocrBusy` dan selalu menghapus direktori kerja sementara di blok `finally`.

### Task 3.3 — Ekstraksi terstruktur & pencarian dokumen berbasis cuplikan kontekstual
- [x] **Penomoran halaman & struktur bagian.**
  - `extractStructuredDocxText` membaca `word/document.xml` dari container ZIP `.docx` menggunakan `node:zlib` untuk mempertahankan heading (`#`, `##`, `###`), bullet list (`- `), dan tabel pipa Markdown (`| ... |`), dengan fallback ke `mammoth`.
  - `splitDocumentIntoPages` mendukung pemisahan halaman PDF (`HALAMAN N`), worksheet (`SHEET:`), dan pembagian bagian otomatis untuk dokumen panjang.
- [x] **Perbaikan `search_document` (Contextual Snippet Search).**
  - `searchDocumentSnippets` dan `db.searchDocuments` mencari di seluruh halaman dokumen dan mengembalikan cuplikan kontekstual tepat di sekitar kata kunci beserta label halaman (`pageNumber`, `pageLabel`, `matchedPages`, `snippets`, `excerpt`).
- [x] **Peningkatan `read_document` (Paginated / Section Read).**
  - Tool `read_document` mendukung parameter opsional `page`, `startPage`, `endPage`, dan `maxChars`, serta mengembalikan `totalPages`, `returnedPages`, `pageLabels`, `hasMorePages`, dan `text`.

### Task 3.4 — Analitik Spreadsheet & CSV deterministik (`analyze_spreadsheet`)
- [x] **Parser CSV tangguh (`parseCsvText`, `parseSpreadsheetNumber`).** Mendukung deteksi otomatis delimiter (`,`, `;`, `\t`), quoted fields multi-baris (RFC 4180), penghapusan BOM UTF-8, dan normalisasi angka format Indonesia (`Rp 1.250.000,50`) maupun internasional (`$1,250,000.50`, format akuntansi `(500)`).
- [x] **Mesin komputasi & profil tabel di sisi server (`analyzeSpreadsheetText`).**
  - Mengembalikan daftar `sheetNames`, `selectedSheet`, `totalRows`, `filteredRows`, profil skema tiap kolom (`inferredType`: `numeric`, `text`, `mixed`, `empty`), statistik deterministik (`count`, `sum`, `avg`, `min`, `max`), ringkasan `groupSummary` (`groupByColumn` + `aggregateColumn`), dan sampel baris terfilter (`filterColumn` + `filterValue`).

### Task 3.5 — Konteks dokumen multi-turn, kutipan (reply) dokumen, & perbandingan dokumen
- [x] **Resolusi reply/quote ke pesan dokumen di chat yang sama.**
  - `MessageProcessor.process` otomatis mencocokkan pesan yang di-reply (`quoteContext.present` dan tidak `rejected`) dengan dokumen di workspace aktif (`quoteContext.referencedDocument = { documentId, filename, mimeType }`), serta `AgentRuntime` menyertakan daftar `recentDocuments` workspace aktif di konteks sistem.
  - Kutipan lintas chat tetap ditolak keras (`quote.rejected = true`).
- [x] **Tool `compare_documents` (Perbandingan 2 dokumen dalam workspace yang sama).**
  - Membandingkan dua dokumen di dalam workspace yang sama (`firstDocumentId`, `secondDocumentId`, opsional `focus`) dengan memverifikasi isolasi `(scope, ownerId/chatId)`, menghasilkan ringkasan baris yang ditambah/dihapus, cuplikan fokus, dan selisih numerik antar kolom (`spreadsheetDelta`) untuk file spreadsheet/CSV.
- [x] **Kepatuhan memori.** Giliran yang melibatkan lampiran dokumen atau quote dokumen tetap melewati automatic memory extraction.

### Task 3.6 — Peningkatan pembuatan dokumen (Rich DOCX, XLSX lanjutan, & ekspor PDF)
- [x] **Inline Markdown parsing pada generator DOCX (`createDocx`).**
  - `parseInlineMarkdownTokens` mem-parse `***bold italic***`, `**bold**`, `*italic*`, dan `` `code` `` di dalam paragraf, daftar bullet/nomor, kutipan, dan sel tabel menjadi `TextRun` berformat rapi.
- [x] **Dukungan pembuatan / ekspor dokumen PDF (`create_pdf` & `create_document(format='pdf')`).**
  - `createPdf` (`buildPdf14Buffer`) menghasilkan file multi-halaman `%PDF-1.4` native (tanpa dependency eksternal tambahan) lengkap dengan header, nomor halaman di footer, heading, daftar, dan tabel bergaris.
  - Mematuhi kontrak pengiriman Phase 1: auto-send ke `ctx.chatId` di grup setelah verifikasi ulang record DB & path `storageDir`, penandaan `deliveryStatus='uncertain'` tanpa retry otomatis bila WAHA gagal/timeout, dan alur `ApprovalManager` di DM pribadi.

### Task 3.7 — Manajemen siklus hidup dokumen, deduplikasi `database.js`, & tata kelola storage
- [x] **Pembersihan duplikasi metode di `src/db/database.js`.**
  - Menghapus blok duplikat metode (`saveDocument`, `getDocument`, `listDocuments`, `searchDocuments`, `createUserTask`, `getUserTask`, `listUserTasks`, `updateUserTask`, `listReminders`) di `src/db/database.js` dan menambahkan `deleteDocument`.
- [x] **Tool manajemen dokumen workspace (`delete_document`).**
  - Menghapus record dokumen dari SQLite dan menghapus file fisik di dalam `storageDir` (dengan validasi path traversal) serta mencatat ke `audit_logs` (`action: 'delete_document'`).

### Task 3.8 — Regresi penuh Phase 1–3, performa VPS, dan acceptance WhatsApp
- [x] **Unit test & skrip regresi Phase 3 (`test/unit/phase3-document-intelligence.test.js` & `scripts/phase3-regression.sh`).**
  - Seluruh **217/217** unit test di 29 file test suite lulus (`0` gagal).
- [ ] **Verifikasi penuh di VPS (`/www/wwwroot/bot-project/bubu`).**
  - Jalankan `npm test`, `npm run test:phase1`, `bash scripts/phase2-regression.sh`, dan `bash scripts/phase3-regression.sh` di VPS.
- [ ] **Matriks acceptance WhatsApp langsung (DM Pemilik, Grup A, Grup B):**
  1. Kirim PDF teks multi-halaman (>10 halaman) -> tanya isi di halaman akhir -> Bubu menemukan dan mengutip halaman yang tepat.
  2. Kirim PDF hasil scan (tanpa teks digital) -> Bubu berhasil menjalankan OCR halaman dan menjelaskan isinya.
  3. Kirim file XLSX multi-sheet & CSV ber-delimiter `;` -> tanya total/rata-rata kolom tertentu -> Bubu menghitung akurat menggunakan `analyze_spreadsheet`.
  4. Reply ke pesan dokumen sebelumnya di DM dan Grup A -> Bubu memahami dokumen yang dimaksud tanpa tertukar.
  5. Minta pembuatan DOCX (dengan teks bold/tabel), XLSX, dan PDF di DM (uji alur `/approve`) serta di Grup A (uji auto-delivery ke Grup A).
  6. Uji isolasi Grup A vs Grup B -> pastikan dokumen yang diunggah atau dibuat di Grup A tidak pernah bisa dicari, dibaca, dibandingkan, atau dikirim di Grup B maupun DM.

---

## 5. Manifest SHA-256 File Phase 3 (Siap Deploy ke VPS)

```text
e3dc1137792534b890ead5889be8debb6a637519fd128a4e086ee2a04bf29c59  src/index.js
01498ec98439525a2d684ab85bafc805ffb8cf57c0add1709f5e635857445de1  src/config/env.js
84f122cdebcb0d3435e49f7e3ae05f94d085e6fb31aae4bc1cc019f0fd2965d9  src/db/database.js
5d404f436434f34132d5a0157e54219752673fe49bbf1a47fd65b9ff38538f85  src/p1/documents/service.js
767c1bdce849c62c30ec5b75d570d40e1eb72d89a6a0e3106bfa87ce64c987b2  src/p1/tools.js
33e3eb72a780a241642933da46fc8333aaf24d08c160b0dc93c46e46f7296b60  src/channels/waha/client.js
e09a142f9c95fa06bcc907880e64bde3d978c39f280348f66eb08ab96dd90485  src/agent/message-processor.js
ade77c3b988afe43f7d4e77243129fbcc8f829aff009af5a2520f5f3181483d2  src/agent/runtime.js
19e31d7760ffc777073f2750610824aa46f548586fd96bf412ea17fcb110b638  test/unit/phase3-document-intelligence.test.js
207e847ba7d21d295512bc0bd15b1c1704215f708398b218063906dde37b9161  scripts/phase3-regression.sh
3fc998e3cb27a9d41985f26145a6c21cbe78e55d8492889a5956dc3b80516910  package.json (unchanged)
```

---

## 6. Prosedur setiap patch dan penutupan fase

1. **Sebelum deploy.** Pemilik memverifikasi hash file target dan menyimpan backup source serta SQLite (`npm run backup`).
2. **Kebijakan konfigurasi.** Pertahankan `.env` tetap minimal; seluruh nilai default baru wajib berada di `src/config/env.js`.
3. **Deploy oleh pemilik.** Terapkan overlay file yang berubah tanpa menimpa `.env`, `data/`, atau `storage/`. Jalankan `node --check`, `npm test`, `npm run test:phase1`, `bash scripts/phase2-regression.sh`, dan `bash scripts/phase3-regression.sh`.
4. **Rollback.** Kembalikan file source yang dicadangkan (dan backup SQLite bila ada migrasi skema) lalu restart PM2 jika ditemukan regresi.
5. **Tutup task berdasarkan bukti.** Gunakan format `task | build | skenario | DM/grup | hasil | durasi/kategori | konfirmasi pemilik`.

**Phase 3 lulus** setelah seluruh suite regresi Phase 1, Phase 2, dan Phase 3 lulus di VPS serta pemilik mengonfirmasi matriks acceptance dokumen (PDF teks panjang, PDF scan OCR, analitik XLSX/CSV, reply dokumen same-chat, pembuatan DOCX/XLSX/PDF, dan isolasi workspace DM/grup) pada WhatsApp nyata.
