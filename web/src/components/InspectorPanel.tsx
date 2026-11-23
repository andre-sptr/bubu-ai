import { useEffect, useRef } from 'react';
import { STAGE_BY_ID } from '../data/stages';
import type {
  AppMode,
  ConnectionState,
  PipelineRun,
  StageId,
  VisualizerSnapshot
} from '../types/pipeline';
import { IconClose, IconPlay } from './Icons';

interface InspectorPanelProps {
  open: boolean;
  isDrawerMode: boolean;
  mode: AppMode;
  connection: ConnectionState;
  connectionError: string | null;
  snapshot: VisualizerSnapshot | null;
  activeRun: PipelineRun | null;
  selectedStage: StageId;
  onClose: () => void;
  onRetryConnection: () => void;
  onStartQuickSimulation: () => void;
  onReplayRun: (run: PipelineRun) => void;
}

function formatRunStatus(status: PipelineRun['status']): string {
  switch (status) {
    case 'running':
      return 'Sedang Memproses';
    case 'waiting_approval':
      return 'Menunggu /approve';
    case 'failed':
      return 'Gagal';
    case 'completed':
      return 'Selesai';
  }
}

function formatTimeShort(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return '-';
  }
}

function InspectorBody({
  mode,
  connection,
  connectionError,
  snapshot,
  activeRun,
  selectedStage,
  onRetryConnection,
  onStartQuickSimulation,
  onReplayRun
}: Omit<InspectorPanelProps, 'open' | 'isDrawerMode' | 'onClose'>) {
  const stageDef = STAGE_BY_ID[selectedStage];
  const stageRunState = activeRun?.stages?.[selectedStage];
  const latestEvent = activeRun?.timeline?.[activeRun.timeline.length - 1] || null;
  const telemetry = snapshot?.telemetry24h;
  const queue = snapshot?.worker?.queue;

  return (
    <div className="inspector-body">
      <section className="inspector-section" aria-labelledby="sec-activity">
        <h2 id="sec-activity" className="sec-title">Aktivitas Saat Ini</h2>

        {connection === 'connecting' && !snapshot && mode === 'live' && (
          <div className="state-box">
            <p className="state-title">Menghubungkan ke stream telemetry Bubu AI</p>
            <p className="state-desc">Memuat snapshot status antrean dan riwayat eksekusi terbaru.</p>
          </div>
        )}

        {connection === 'error' && mode === 'live' && (
          <div className="state-box is-error" role="alert">
            <p className="state-title">Koneksi Live Terputus</p>
            <p className="state-desc">{connectionError || 'Endpoint SSE tidak merespons.'}</p>
            <div className="state-actions">
              <button type="button" className="btn-inline" onClick={onRetryConnection}>
                Coba Sambung Lagi
              </button>
              <button type="button" className="btn-inline primary" onClick={onStartQuickSimulation}>
                Jalankan Simulasi
              </button>
            </div>
          </div>
        )}

        {activeRun ? (
          <div className="run-card">
            <div className="run-card-top">
              <span className={`run-pill status-${activeRun.status}`}>
                {formatRunStatus(activeRun.status)}
              </span>
              <span className="mono-chip">
                {activeRun.simulated ? 'SIMULASI' : activeRun.hydrated ? 'RIWAYAT' : 'LIVE'} : {activeRun.chatRef}
              </span>
            </div>
            <p className="run-narrative">
              {latestEvent?.label || 'Memantau tahap eksekusi.'}
            </p>
            <dl className="kv-grid">
              <div>
                <dt>Tipe Input</dt>
                <dd className="mono-val">{activeRun.inputKind || 'text'} ({activeRun.scope})</dd>
              </div>
              <div>
                <dt>Tier &amp; Model</dt>
                <dd className="mono-val">
                  {activeRun.modelTier ? `${activeRun.modelTier} / ${activeRun.modelId || '-'}` : 'Belum dipilih'}
                </dd>
              </div>
              <div>
                <dt>Mode Balasan</dt>
                <dd className="mono-val">
                  {activeRun.outputMode ? (activeRun.ttsUsed ? `${activeRun.outputMode} (Piper TTS)` : activeRun.outputMode) : '-'}
                </dd>
              </div>
              <div>
                <dt>Run ID</dt>
                <dd className="mono-val">{activeRun.runId}</dd>
              </div>
            </dl>
          </div>
        ) : (
          connection !== 'error' && (
            <div className="state-box">
              <p className="state-title">Bubu Siaga Menunggu Pesan WhatsApp</p>
              <p className="state-desc">
                Kirim pesan ke WhatsApp Bubu untuk melihat paket sinyal 3D berjalan otomatis, atau uji alur dengan mode simulasi.
              </p>
              <div className="state-actions">
                <button type="button" className="btn-inline primary" onClick={onStartQuickSimulation}>
                  <IconPlay />
                  <span>Uji Simulasi Alur 3D</span>
                </button>
              </div>
            </div>
          )
        )}
      </section>

      <section className="inspector-section" aria-labelledby="sec-stage">
        <div className="sec-head-row">
          <h2 id="sec-stage" className="sec-title">Stasiun {stageDef.index}: {stageDef.name}</h2>
        </div>
        <p className="module-path">{stageDef.sourceModule}</p>
        <p className="stage-desc">{stageDef.roleSummary}</p>
        <p className="stage-tech">{stageDef.technicalDetails}</p>
        {stageRunState && (
          <div className="stage-live-meta">
            <span className="meta-label">Status pada run aktif:</span>
            <span className="mono-val">{stageRunState.label}</span>
            {stageRunState.durationMs !== null && stageRunState.durationMs !== undefined && (
              <span className="mono-val">Durasi: {stageRunState.durationMs} ms</span>
            )}
            {stageRunState.meta?.parallelTools && (
              <span className="mono-val">Paralel: {stageRunState.meta.parallelTools.join(', ')}</span>
            )}
          </div>
        )}
      </section>

      <section className="inspector-section" aria-labelledby="sec-telemetry">
        <h2 id="sec-telemetry" className="sec-title">Telemetri Nyata (24 Jam)</h2>
        {telemetry && telemetry.totalCalls > 0 ? (
          <dl className="kv-grid">
            <div>
              <dt>Panggilan Model</dt>
              <dd className="mono-val">{telemetry.totalCalls} ({telemetry.successCalls} sukses)</dd>
            </div>
            <div>
              <dt>Rata-rata Latensi</dt>
              <dd className="mono-val">{telemetry.avgLatencyMs} ms</dd>
            </div>
            <div>
              <dt>Total Token</dt>
              <dd className="mono-val">{telemetry.totalInputTokens.toLocaleString('id-ID')} in / {telemetry.totalOutputTokens.toLocaleString('id-ID')} out</dd>
            </div>
            <div>
              <dt>Antrean SQLite</dt>
              <dd className="mono-val">
                {queue
                  ? `${queue.processingCount} aktif, ${queue.pendingCount} antri, ${queue.deadCount} dead`
                  : 'Tidak tersedia'}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="empty-note">Belum ada panggilan model tercatat pada 24 jam terakhir.</p>
        )}
      </section>

      <section className="inspector-section" aria-labelledby="sec-history">
        <h2 id="sec-history" className="sec-title">Riwayat Eksekusi Terbaru</h2>
        {snapshot?.recentRuns && snapshot.recentRuns.length > 0 ? (
          <ul className="history-list">
            {snapshot.recentRuns.slice(0, 8).map((run) => (
              <li key={run.runId}>
                <button
                  type="button"
                  className="history-btn"
                  onClick={() => onReplayRun(run)}
                >
                  <span className="history-top">
                    <span className="mono-val">{run.chatRef}</span>
                    <span className={`history-status status-${run.status}`}>{formatRunStatus(run.status)}</span>
                  </span>
                  <span className="history-bottom">
                    <span>{run.modelId || run.modelTier || 'Perintah / cepat'}</span>
                    <span className="mono-val">{formatTimeShort(run.updatedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-note">Belum ada riwayat eksekusi pesan di basis data.</p>
        )}
      </section>
    </div>
  );
}

export function InspectorPanel(props: InspectorPanelProps) {
  const { open, isDrawerMode, onClose } = props;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const isOpenRef = useRef(false);
  const hasEnteredRef = useRef(false);
  const openingGuardRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    const scroller = scrollerRef.current;
    const sheet = sheetRef.current;
    if (!isDrawerMode || !dialog || !scroller || !sheet) return;

    const visibleThreshold = 1 / Math.max(window.innerWidth, 320);
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        if (entry.intersectionRatio >= visibleThreshold) {
          hasEnteredRef.current = true;
          openingGuardRef.current = false;
        }
        if (
          entry.intersectionRatio < visibleThreshold &&
          isOpenRef.current &&
          hasEnteredRef.current &&
          !openingGuardRef.current
        ) {
          isOpenRef.current = false;
          hasEnteredRef.current = false;
          if (dialog.open) dialog.close();
          onClose();
        }
      },
      { root: dialog, threshold: [visibleThreshold, 1] }
    );
    observer.observe(sheet);

    const onScrollFallback = !CSS.supports('animation-timeline: scroll()')
      ? () => {
          const maxScroll = Math.max(1, scroller.scrollWidth - scroller.clientWidth);
          const ratio = Math.max(0, Math.min(1, scroller.scrollLeft / maxScroll));
          dialog.style.setProperty('--drawer-backdrop', String(ratio));
        }
      : null;

    if (onScrollFallback) {
      scroller.addEventListener('scroll', onScrollFallback, { passive: true });
    }

    return () => {
      observer.disconnect();
      if (onScrollFallback) scroller.removeEventListener('scroll', onScrollFallback);
    };
  }, [isDrawerMode, onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const scroller = scrollerRef.current;
    if (!isDrawerMode || !dialog || !scroller) return;

    let guardTimer: number | null = null;

    if (open && !dialog.open) {
      isOpenRef.current = true;
      hasEnteredRef.current = false;
      openingGuardRef.current = true;
      dialog.showModal();
      const targetLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (reduced) {
        scroller.scrollTo({ left: targetLeft, behavior: 'instant' as ScrollBehavior });
        openingGuardRef.current = false;
        hasEnteredRef.current = true;
      } else {
        if (!CSS.supports('scroll-initial-target', 'nearest')) {
          scroller.scrollTo({ left: 0, behavior: 'instant' as ScrollBehavior });
        }
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const scrollTarget = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
            scroller.scrollTo({ left: scrollTarget, behavior: 'auto' });
          });
        });
        guardTimer = window.setTimeout(() => {
          openingGuardRef.current = false;
        }, 450);
      }
    } else if (!open && dialog.open) {
      isOpenRef.current = false;
      hasEnteredRef.current = false;
      openingGuardRef.current = false;
      scroller.scrollTo({ left: 0, behavior: 'auto' });
      window.setTimeout(() => {
        if (dialog.open) dialog.close();
      }, 220);
    }

    return () => {
      if (guardTimer !== null) window.clearTimeout(guardTimer);
    };
  }, [isDrawerMode, open]);

  const requestDrawerClose = () => {
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollTo({ left: 0, behavior: 'auto' });
    }
    isOpenRef.current = false;
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
    onClose();
  };

  if (!isDrawerMode) {
    if (!open) return null;
    return (
      <aside id="inspector-aside" className="inspector-aside" aria-label="Panel Inspektor Alur Bubu AI">
        <div className="inspector-head">
          <span className="inspector-head-title">Inspektor Pipeline</span>
          <button
            type="button"
            className="icon-close-btn"
            aria-label="Tutup panel inspektor"
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>
        <InspectorBody {...props} />
      </aside>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      id="inspector-drawer"
      className="Drawer"
      aria-labelledby="drawer-heading"
      onClick={(e) => {
        if (sheetRef.current && !sheetRef.current.contains(e.target as Node)) {
          requestDrawerClose();
        }
      }}
      onCancel={(e) => {
        if (e.cancelable) {
          e.preventDefault();
          requestDrawerClose();
        }
      }}
    >
      <div ref={scrollerRef} className="Drawer-scroller">
        <div ref={sheetRef} className="Drawer-sheet">
          <div className="inspector-head">
            <span id="drawer-heading" className="inspector-head-title">Inspektor Pipeline</span>
            <button
              type="button"
              className="icon-close-btn"
              aria-label="Tutup inspektor"
              onClick={requestDrawerClose}
            >
              <IconClose />
            </button>
          </div>
          <InspectorBody {...props} />
        </div>
      </div>
    </dialog>
  );
}
