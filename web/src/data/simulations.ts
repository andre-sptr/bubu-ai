import type { SimulationScenario } from '../types/pipeline';

export const SIMULATION_SCENARIOS: readonly SimulationScenario[] = [
  {
    id: 'fast-greeting',
    title: 'Sapaan Cepat (Fast Path)',
    shortTitle: 'Sapaan Cepat',
    scope: 'personal',
    inputKind: 'text',
    summary: 'Pesan teks singkat melewati media & tool loop, diproses model fast (claude-haiku-5-5).',
    steps: [
      {
        delayMs: 0,
        stage: 'ingress',
        phase: 'completed',
        label: 'Webhook WAHA menerima pesan teks singkat',
        meta: { inputKind: 'text', priority: 2, charCount: 14, isGroup: false }
      },
      {
        delayMs: 520,
        stage: 'queue',
        phase: 'started',
        label: 'InboxWorker mengklaim antrean prioritas DM',
        meta: { priority: 2, attempts: 1, queuePending: 0, queueProcessing: 1 }
      },
      {
        delayMs: 420,
        stage: 'gate',
        phase: 'completed',
        label: 'Terverifikasi DM pemilik, sendSeen & typing aktif',
        meta: { isGroup: false, inputKind: 'text' }
      },
      {
        delayMs: 440,
        stage: 'multimodal',
        phase: 'bypassed',
        label: 'Pesan teks langsung melewati stasiun media',
        meta: { bypassed: true }
      },
      {
        delayMs: 420,
        stage: 'context',
        phase: 'completed',
        label: 'Jalur cepat sapaan (tanpa pencarian vektor memori)',
        meta: { isFastPath: true, taskClass: 'greeting', memoryCount: 0, durationMs: 6 }
      },
      {
        delayMs: 520,
        stage: 'llm',
        phase: 'started',
        label: 'Memproses penalaran model Sumopod (Putaran 1)',
        meta: { taskClass: 'greeting', modelTier: 'fast', modelId: 'claude-haiku-5-5', round: 1, maxRounds: 5, toolSchemaCount: 0 }
      },
      {
        delayMs: 720,
        stage: 'llm',
        phase: 'completed',
        label: 'Jawaban final selesai disusun',
        meta: { modelTier: 'fast', modelId: 'claude-haiku-5-5', round: 1, latencyMs: 390, inputTokens: 420, outputTokens: 34, toolCount: 0 }
      },
      {
        delayMs: 300,
        stage: 'tools',
        phase: 'bypassed',
        label: 'Tidak memerlukan eksekusi tool',
        meta: { bypassed: true }
      },
      {
        delayMs: 460,
        stage: 'delivery',
        phase: 'started',
        label: 'Memformat & mengirim balasan teks WhatsApp',
        meta: { outputMode: 'text', ttsUsed: false }
      },
      {
        delayMs: 520,
        stage: 'delivery',
        phase: 'completed',
        label: 'Balasan teks terkirim ke WhatsApp',
        meta: { outputMode: 'text', ttsUsed: false, chunks: 1, durationMs: 85 },
        runCompleted: true
      }
    ]
  },
  {
    id: 'parallel-research',
    title: 'Riset & Tool Paralel',
    shortTitle: 'Riset Paralel',
    scope: 'group',
    inputKind: 'text',
    summary: 'Pertanyaan riset grup memicu Opus 5.5, batch tool paralel (web + memory), sintesis putaran ke-2, dan memory capture.',
    steps: [
      {
        delayMs: 0,
        stage: 'ingress',
        phase: 'completed',
        label: 'Webhook menerima pertanyaan ber-mention di grup',
        meta: { inputKind: 'text', priority: 5, charCount: 112, isGroup: true }
      },
      {
        delayMs: 480,
        stage: 'queue',
        phase: 'started',
        label: 'InboxWorker mengklaim slot FIFO grup',
        meta: { priority: 5, attempts: 1, queuePending: 0, queueProcessing: 1 }
      },
      {
        delayMs: 460,
        stage: 'gate',
        phase: 'completed',
        label: 'Lolos gerbang grup (@bubu) & typing keepalive aktif',
        meta: { isGroup: true, inputKind: 'text' }
      },
      {
        delayMs: 420,
        stage: 'multimodal',
        phase: 'bypassed',
        label: 'Pesan teks langsung melewati stasiun media',
        meta: { bypassed: true }
      },
      {
        delayMs: 520,
        stage: 'context',
        phase: 'started',
        label: 'Memuat riwayat grup, memori semantik, & konteks proyek',
        meta: { isFastPath: false, taskClass: 'agent' }
      },
      {
        delayMs: 620,
        stage: 'context',
        phase: 'completed',
        label: 'Konteks siap (6 memori + 1 proyek grup)',
        meta: { isFastPath: false, taskClass: 'agent', memoryCount: 6, projectCount: 1, durationMs: 48 }
      },
      {
        delayMs: 520,
        stage: 'llm',
        phase: 'started',
        label: 'Memproses penalaran model Sumopod (Putaran 1)',
        meta: { taskClass: 'agent', modelTier: 'reasoning', modelId: 'claude-opus-5-5', round: 1, maxRounds: 5, toolSchemaCount: 14 }
      },
      {
        delayMs: 920,
        stage: 'llm',
        phase: 'progress',
        label: 'Model memilih 2 tool read-only paralel',
        meta: { modelTier: 'reasoning', modelId: 'claude-opus-5-5', round: 1, latencyMs: 880, inputTokens: 1840, outputTokens: 96, toolCount: 2 }
      },
      {
        delayMs: 500,
        stage: 'tools',
        phase: 'started',
        label: 'Menjalankan batch tool paralel: web_search + search_memory',
        meta: { parallel: true, parallelTools: ['web_search', 'search_memory'], toolGroups: ['web', 'memory'], toolGroup: 'web', toolCount: 2 }
      },
      {
        delayMs: 960,
        stage: 'tools',
        phase: 'completed',
        label: 'Hasil batch paralel diterima (web_search + search_memory)',
        meta: { parallel: true, parallelTools: ['web_search', 'search_memory'], toolGroups: ['web', 'memory'], toolGroup: 'web', durationMs: 640 }
      },
      {
        delayMs: 540,
        stage: 'llm',
        phase: 'started',
        label: 'Sintesis hasil tool pada Putaran 2',
        meta: { taskClass: 'agent', modelTier: 'reasoning', modelId: 'claude-opus-5-5', round: 2, maxRounds: 5 }
      },
      {
        delayMs: 880,
        stage: 'llm',
        phase: 'completed',
        label: 'Jawaban final terstruktur selesai disusun',
        meta: { modelTier: 'reasoning', modelId: 'claude-opus-5-5', round: 2, latencyMs: 810, inputTokens: 2950, outputTokens: 410, toolCount: 0 }
      },
      {
        delayMs: 500,
        stage: 'delivery',
        phase: 'started',
        label: 'Memecah & mengirim balasan WhatsApp ber-quote',
        meta: { outputMode: 'text', ttsUsed: false }
      },
      {
        delayMs: 620,
        stage: 'delivery',
        phase: 'completed',
        label: 'Balasan 2 bagian terkirim ke grup',
        meta: { outputMode: 'text', ttsUsed: false, chunks: 2, durationMs: 210 },
        runCompleted: false
      },
      {
        delayMs: 560,
        stage: 'context',
        phase: 'progress',
        label: 'Menyimpan memori episodik pasca-percakapan',
        meta: { postTurn: true },
        runCompleted: true
      }
    ]
  },
  {
    id: 'voice-note-tts',
    title: 'Voice Note ke Balasan Suara',
    shortTitle: 'Voice -> TTS',
    scope: 'personal',
    inputKind: 'voice_note',
    summary: 'Voice note masuk ditranskripsi lokal via Silero VAD + Whisper.cpp, lalu dibalas dengan suara Piper TTS OGG/Opus.',
    steps: [
      {
        delayMs: 0,
        stage: 'ingress',
        phase: 'completed',
        label: 'Webhook WAHA menerima voice note (PTT)',
        meta: { inputKind: 'voice_note', priority: 2, isGroup: false }
      },
      {
        delayMs: 460,
        stage: 'queue',
        phase: 'started',
        label: 'InboxWorker mengklaim event voice note',
        meta: { priority: 2, attempts: 1, queuePending: 0, queueProcessing: 1 }
      },
      {
        delayMs: 440,
        stage: 'gate',
        phase: 'completed',
        label: 'Terverifikasi DM pemilik, reaksi proses dikirim',
        meta: { isGroup: false, inputKind: 'voice_note' }
      },
      {
        delayMs: 520,
        stage: 'multimodal',
        phase: 'started',
        label: 'Transkripsi lokal Silero VAD + Whisper.cpp + FFmpeg 16kHz',
        meta: { mediaKind: 'audio' }
      },
      {
        delayMs: 1100,
        stage: 'multimodal',
        phase: 'completed',
        label: 'Instruksi suara berhasil ditranskripsikan',
        meta: { mediaKind: 'audio', durationMs: 1050 }
      },
      {
        delayMs: 540,
        stage: 'context',
        phase: 'completed',
        label: 'Memuat 4 memori personal terkait',
        meta: { isFastPath: false, taskClass: 'tool_action', memoryCount: 4, durationMs: 29 }
      },
      {
        delayMs: 520,
        stage: 'llm',
        phase: 'started',
        label: 'Memproses instruksi dengan model balanced (Sonnet 5.5)',
        meta: { taskClass: 'tool_action', modelTier: 'balanced', modelId: 'claude-sonnet-5-5', round: 1, maxRounds: 5 }
      },
      {
        delayMs: 780,
        stage: 'llm',
        phase: 'progress',
        label: 'Model menjadwalkan pengingat lewat tool produktivitas',
        meta: { modelTier: 'balanced', modelId: 'claude-sonnet-5-5', round: 1, latencyMs: 620, inputTokens: 1120, outputTokens: 64, toolCount: 1 }
      },
      {
        delayMs: 500,
        stage: 'tools',
        phase: 'started',
        label: 'Menjalankan tool create_reminder',
        meta: { parallel: false, toolName: 'create_reminder', toolGroup: 'productivity' }
      },
      {
        delayMs: 560,
        stage: 'tools',
        phase: 'completed',
        label: 'Pengingat tersimpan di SQLite',
        meta: { toolName: 'create_reminder', toolGroup: 'productivity', durationMs: 14 }
      },
      {
        delayMs: 520,
        stage: 'llm',
        phase: 'completed',
        label: 'Konfirmasi akhir siap dikirim',
        meta: { modelTier: 'balanced', modelId: 'claude-sonnet-5-5', round: 2, latencyMs: 490, inputTokens: 1380, outputTokens: 78, toolCount: 0 }
      },
      {
        delayMs: 540,
        stage: 'delivery',
        phase: 'started',
        label: 'Sintesis suara Piper TTS + encoding FFmpeg OGG/Opus',
        meta: { outputMode: 'both', ttsUsed: true }
      },
      {
        delayMs: 920,
        stage: 'delivery',
        phase: 'completed',
        label: 'Teks & voice note balasan terkirim ke WhatsApp',
        meta: { outputMode: 'both', ttsUsed: true, chunks: 1, durationMs: 680 },
        runCompleted: true
      }
    ]
  },
  {
    id: 'pdf-approval',
    title: 'PDF OCR & Gerbang Persetujuan',
    shortTitle: 'PDF + Approve',
    scope: 'personal',
    inputKind: 'media',
    summary: 'PDF scan diproses via Tesseract OCR + Gemini 3.1 Pro, lalu pengiriman file keluar ditahan di gerbang /approve.',
    steps: [
      {
        delayMs: 0,
        stage: 'ingress',
        phase: 'completed',
        label: 'Webhook menerima lampiran dokumen PDF',
        meta: { inputKind: 'media', priority: 2, isGroup: false }
      },
      {
        delayMs: 460,
        stage: 'queue',
        phase: 'started',
        label: 'InboxWorker mengklaim pemrosesan dokumen',
        meta: { priority: 2, attempts: 1, queuePending: 0, queueProcessing: 1 }
      },
      {
        delayMs: 440,
        stage: 'gate',
        phase: 'completed',
        label: 'Verifikasi DM pemilik selesai, typing aktif',
        meta: { isGroup: false, inputKind: 'media' }
      },
      {
        delayMs: 520,
        stage: 'multimodal',
        phase: 'started',
        label: 'Merender halaman PDF + Tesseract OCR (ind+eng)',
        meta: { mediaKind: 'document' }
      },
      {
        delayMs: 1180,
        stage: 'multimodal',
        phase: 'completed',
        label: 'Ekstraksi hybrid PDF + OCR selesai (4 halaman)',
        meta: { mediaKind: 'document', extractionMode: 'hybrid_ocr', durationMs: 1120 }
      },
      {
        delayMs: 520,
        stage: 'context',
        phase: 'completed',
        label: 'Dokumen terindeks & konteks workspace dimuat',
        meta: { isFastPath: false, taskClass: 'summarize', docCount: 1, memoryCount: 3, durationMs: 32 }
      },
      {
        delayMs: 540,
        stage: 'llm',
        phase: 'started',
        label: 'Menyusun ringkasan via tier summary (Gemini 3.1 Pro)',
        meta: { taskClass: 'summarize', modelTier: 'summary', modelId: 'gemini/gemini-3.1-pro-preview', round: 1, maxRounds: 5 }
      },
      {
        delayMs: 920,
        stage: 'llm',
        phase: 'progress',
        label: 'Model meminta pengiriman file lintas-chat',
        meta: { modelTier: 'summary', modelId: 'gemini/gemini-3.1-pro-preview', round: 1, latencyMs: 840, inputTokens: 3200, outputTokens: 180, toolCount: 1 }
      },
      {
        delayMs: 520,
        stage: 'tools',
        phase: 'waiting',
        label: 'Ditahan di gerbang keamanan: menunggu /approve pemilik',
        meta: { toolName: 'send_whatsapp_file', toolGroup: 'waha', pendingApproval: true, approvalStatus: 'awaiting_approval' }
      },
      {
        delayMs: 1350,
        stage: 'tools',
        phase: 'completed',
        label: 'Pemilik menyetujui (/approve): file siap diteruskan',
        meta: { toolName: 'send_whatsapp_file', toolGroup: 'waha', pendingApproval: false, approvalStatus: 'approved', durationMs: 1300 }
      },
      {
        delayMs: 520,
        stage: 'delivery',
        phase: 'completed',
        label: 'Dokumen & konfirmasi pengiriman terkirim via WAHA',
        meta: { outputMode: 'text', ttsUsed: false, chunks: 1, durationMs: 240 },
        runCompleted: true
      }
    ]
  }
];
