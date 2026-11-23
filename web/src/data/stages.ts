import type { StageDefinition, StageId } from '../types/pipeline';

export const STAGE_DEFINITIONS: readonly StageDefinition[] = [
  {
    id: 'ingress',
    index: 1,
    shortName: 'Ingress',
    name: 'Lobby & Webhook Ingress',
    sourceModule: 'src/app.js (POST /webhook)',
    roleSummary: 'Meja resepsionis webhook WAHA GOWS yang menerima event masuk, memverifikasi token serta HMAC-SHA512, dan menormalkan payload.',
    technicalDetails: 'Setiap pesan dihitung hash eventKey serta diprioritaskan (1 perintah owner, 2 DM, 5 grup) sebelum masuk ruang antrean.',
    position3D: [-7.5, 0, -3.4],
    accentRole: 'transport'
  },
  {
    id: 'queue',
    index: 2,
    shortName: 'Antrean',
    name: 'Ruang Server Antrean SQLite',
    sourceModule: 'src/db/repositories/inbox.repository.js + src/workers/inbox-worker.js',
    roleSummary: 'Rak server SQLite WAL tempat penyimpanan pesan durable dan klaim pekerjaan atomik per chat secara FIFO.',
    technicalDetails: 'Dilengkapi lock heartbeat berkala, backoff eksponensial hingga 5 kali retry, dan karantina dead-letter aman.',
    position3D: [-2.5, 0, -3.4],
    accentRole: 'transport'
  },
  {
    id: 'gate',
    index: 3,
    shortName: 'Gerbang',
    name: 'Pos Keamanan & Presence',
    sourceModule: 'src/agent/message-processor.js',
    roleSummary: 'Pos pemeriksaan izin DM/Grup, resolusi @lid ke JID, rate limit, serta aktivasi seen dan typing keepalive.',
    technicalDetails: 'Pesan grup tanpa mention atau perintah slash disaring di gerbang ini sementara typing keepalive berjalan paralel.',
    position3D: [2.5, 0, -3.4],
    accentRole: 'transport'
  },
  {
    id: 'multimodal',
    index: 4,
    shortName: 'Multimodal',
    name: 'Lab Media, OCR & Audio',
    sourceModule: 'src/media/media-service.js + src/documents/document-service.js',
    roleSummary: 'Ruang lab khusus untuk memproses gambar, voice note, video, dan dokumen PDF/DOCX/XLSX secara lokal.',
    technicalDetails: 'Mengoperasikan FFmpeg, Tesseract OCR (ind+eng), Whisper.cpp + Silero VAD, serta parser dokumen. Teks murni melewati jalur bypass.',
    position3D: [7.5, 0, -3.4],
    accentRole: 'cognition'
  },
  {
    id: 'context',
    index: 5,
    shortName: 'Memori',
    name: 'Arsip Digital & Memori Vektor',
    sourceModule: 'src/memory/memory-service.js + src/agent/prompt-builder.js',
    roleSummary: 'Perpustakaan konteks yang mengambil riwayat chat, memori semantik hibrida, proyek aktif, dan dokumen workspace.',
    technicalDetails: 'Menggabungkan kemiripan kosinus + leksikal berbudget JSON aman, serta menerima penyimpanan memori episodik pasca-balasan.',
    position3D: [-7.5, 0, 3.2],
    accentRole: 'cognition'
  },
  {
    id: 'llm',
    index: 6,
    shortName: 'Inti AI',
    name: 'Ruang Komando Inti Sumopod',
    sourceModule: 'src/agent/model-router.js + src/agent/runtime.js',
    roleSummary: 'Pusat komando eksekutif yang merutekan tier model (Haiku, Sonnet, Opus, Gemini Pro) dalam loop hingga 5 putaran.',
    technicalDetails: 'Mendukung eskalasi tier otomatis dari fast ke balanced saat sintesis lanjutan dan fallback cepat saat gangguan sementara.',
    position3D: [-2.5, 0, 3.2],
    accentRole: 'cognition'
  },
  {
    id: 'tools',
    index: 7,
    shortName: 'Tools',
    name: 'Hub 5 Pod Operasi Tools',
    sourceModule: 'src/agent/tool-registry.js + src/agent/approval-manager.js',
    roleSummary: 'Kluster 5 meja pod engineering terisolasi per domain (memory, productivity, web, documents, waha).',
    technicalDetails: 'Batch read-only berjalan paralel di beberapa pod sekaligus, sementara aksi eksternal berisiko menunggu /approve pemilik.',
    position3D: [2.5, 0, 3.2],
    accentRole: 'cognition'
  },
  {
    id: 'delivery',
    index: 8,
    shortName: 'Kirim WA',
    name: 'Studio Siar & Pengiriman WAHA',
    sourceModule: 'src/channels/response-handler.js + src/channels/whatsapp-formatter.js',
    roleSummary: 'Studio outbound yang memformat teks WhatsApp, memecah pesan panjang, menyintesis suara Piper TTS, dan mengirim ke WAHA.',
    technicalDetails: 'Seluruh pengiriman keluar terpusat di ResponseHandler dengan status outbox atomik untuk mencegah pesan ganda.',
    position3D: [7.5, 0, 3.2],
    accentRole: 'transport'
  }
];

export const STAGE_BY_ID: Record<StageId, StageDefinition> = STAGE_DEFINITIONS.reduce(
  (acc, item) => {
    acc[item.id] = item;
    return acc;
  },
  {} as Record<StageId, StageDefinition>
);

export const TOOL_DOMAIN_NODES = [
  { id: 'memory', label: 'Memory', offset: [0.0, 0.0, -1.32] as [number, number, number] },
  { id: 'productivity', label: 'Tasks', offset: [1.26, 0.0, -0.41] as [number, number, number] },
  { id: 'web', label: 'Web', offset: [0.78, 0.0, 1.07] as [number, number, number] },
  { id: 'documents', label: 'Docs', offset: [-0.78, 0.0, 1.07] as [number, number, number] },
  { id: 'waha', label: 'WAHA', offset: [-1.26, 0.0, -0.41] as [number, number, number] }
] as const;
