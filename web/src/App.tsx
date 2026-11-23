import { useCallback, useEffect, useRef, useState } from 'react';
import { InspectorPanel } from './components/InspectorPanel';
import { SimulationControls } from './components/SimulationControls';
import { StageStepper } from './components/StageStepper';
import { TopBar } from './components/TopBar';
import { WebGLFallback } from './components/WebGLFallback';
import { STAGE_DEFINITIONS } from './data/stages';
import { useVisualizerStream } from './hooks/useVisualizerStream';
import { PipelineScene, type ProjectedLabel } from './scene/PipelineScene';
import type { CameraPreset, PipelineEvent, PipelineRun, StageId, ThemeMode } from './types/pipeline';

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem('bubu-visualizer-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Ignore storage access errors.
  }
  return 'dark';
}

function getInitialDesktop(): boolean {
  return typeof window !== 'undefined' ? window.innerWidth >= 1200 : true;
}

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('follow');
  const [selectedStage, setSelectedStage] = useState<StageId>('llm');
  const [isDesktop, setIsDesktop] = useState<boolean>(getInitialDesktop);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(getInitialDesktop);
  const [webglFailed, setWebglFailed] = useState(false);

  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<PipelineScene | null>(null);
  const labelRefs = useRef<Partial<Record<StageId, HTMLButtonElement | null>>>({});

  // Sync theme attribute and meta theme-color in lockstep across all surfaces & controls
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-switching');
    root.dataset.theme = theme;
    void root.offsetHeight;
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', theme === 'dark' ? '#0B0E11' : '#F4F6F8');
    }
    try {
      localStorage.setItem('bubu-visualizer-theme', theme);
    } catch {
      // Ignore storage error.
    }
    sceneRef.current?.setTheme(theme);
    const raf = requestAnimationFrame(() => {
      root.classList.remove('theme-switching');
    });
    return () => cancelAnimationFrame(raf);
  }, [theme]);

  // Listen to OS reduced-motion preference
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => {
      setReducedMotion(mq.matches);
      sceneRef.current?.setReducedMotion(mq.matches);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Track desktop vs drawer breakpoint
  useEffect(() => {
    const onResize = () => {
      const wide = window.innerWidth >= 1200;
      setIsDesktop((prevWide) => {
        if (prevWide !== wide) {
          setInspectorOpen(wide);
        }
        return wide;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleSceneEvent = useCallback((ev: PipelineEvent) => {
    sceneRef.current?.applyEvent(ev);
  }, []);

  const handleSceneSyncRun = useCallback((run: PipelineRun | null) => {
    sceneRef.current?.syncRunState(run);
  }, []);

  const handleSceneReset = useCallback(() => {
    sceneRef.current?.resetToIdle();
  }, []);

  const stream = useVisualizerStream({
    paused,
    onSceneEvent: handleSceneEvent,
    onSceneSyncRun: handleSceneSyncRun,
    onSceneReset: handleSceneReset
  });

  const handleSelectStage = useCallback((stageId: StageId) => {
    setSelectedStage(stageId);
    sceneRef.current?.setSelectedStage(stageId);
    sceneRef.current?.focusStage(stageId);
    setCameraPreset('follow');
  }, []);

  const handleProjectLabels = useCallback((labels: ProjectedLabel[]) => {
    for (const item of labels) {
      const el = labelRefs.current[item.id];
      if (!el) continue;
      if (!item.visible) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
      } else {
        el.style.opacity = '1';
        el.style.pointerEvents = 'auto';
        el.style.transform = `translate3d(${Math.round(item.x)}px, ${Math.round(item.y)}px, 0) translate(-50%, -100%)`;
      }
    }
  }, []);

  // Initialize Three.js WebGL stage once
  useEffect(() => {
    const container = stageContainerRef.current;
    if (!container) return;

    let scene: PipelineScene;
    try {
      scene = new PipelineScene(container, {
        onSelectStage: (stageId) => {
          setSelectedStage(stageId);
          scene.setSelectedStage(stageId);
          scene.focusStage(stageId);
        },
        onHoverStage: () => {},
        onProjectLabels: handleProjectLabels,
        onUserCameraOrbit: () => {}
      });
    } catch {
      setWebglFailed(true);
      return;
    }

    scene.setTheme(theme);
    scene.setPaused(paused);
    scene.setReducedMotion(reducedMotion);
    scene.setSelectedStage(selectedStage);
    sceneRef.current = scene;

    const resizeObs = new ResizeObserver(() => {
      scene.resize();
    });
    resizeObs.observe(container);

    return () => {
      resizeObs.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sceneRef.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    sceneRef.current?.setSelectedStage(selectedStage);
  }, [selectedStage]);

  // Keyboard shortcuts 1-8 to jump directly to station 1-8
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const num = Number(e.key);
      if (num >= 1 && num <= 8) {
        const target = STAGE_DEFINITIONS[num - 1];
        if (target) handleSelectStage(target.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSelectStage]);

  const activeRun = stream.activeDisplayRun;
  const activeHeadline = activeRun?.timeline?.at(-1)?.label
    || (stream.mode === 'live'
      ? 'Siaga memantau webhook WAHA WhatsApp secara real-time'
      : 'Pilih skenario untuk memutar simulasi alur 3D');

  return (
    <div className="app-shell">
      <a href="#main-stage" className="skip-link">Lewati ke panggung 3D</a>

      <TopBar
        connection={stream.connection}
        wahaStatus={stream.snapshot?.waha?.status || null}
        mode={stream.mode}
        paused={paused}
        cameraPreset={cameraPreset}
        theme={theme}
        inspectorOpen={inspectorOpen}
        onSwitchMode={stream.switchMode}
        onTogglePause={() => setPaused((p) => !p)}
        onChangeCameraPreset={(preset) => {
          setCameraPreset(preset);
          sceneRef.current?.setCameraPreset(preset);
        }}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onToggleInspector={() => setInspectorOpen((o) => !o)}
      />

      <div className="workspace">
        <main id="main-stage" className="stage-area" tabIndex={-1}>
          {!webglFailed ? (
            <div ref={stageContainerRef} className="canvas-host" aria-label="Kanvas visualisasi 3D alur Bubu AI">
              <div className="stage-labels-layer" aria-hidden="true">
                {STAGE_DEFINITIONS.map((def) => {
                  const st = activeRun?.stages?.[def.id];
                  const phase = st?.phase || 'idle';
                  const isSel = selectedStage === def.id;
                  return (
                    <button
                      key={def.id}
                      ref={(el) => { labelRefs.current[def.id] = el; }}
                      type="button"
                      tabIndex={-1}
                      className={`pin-label phase-${phase} ${isSel ? 'is-selected' : ''}`}
                      onClick={() => handleSelectStage(def.id)}
                    >
                      <span className="pin-num">{def.index}</span>
                      <span className="pin-text">{def.shortName}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <WebGLFallback
              activeRun={activeRun}
              selectedStage={selectedStage}
              onSelectStage={handleSelectStage}
            />
          )}

          {/* Accessible polite live region announcing high-level step transitions */}
          <div className="visually-hidden" aria-live="polite" aria-atomic="true">
            {activeHeadline}
          </div>

          <div className="stage-hud-top">
            <div className="hud-narrative">
              <span className="hud-kicker">
                {stream.mode === 'simulation'
                  ? (activeRun?.hydrated ? 'PUTAR ULANG RIWAYAT' : 'SIMULASI')
                  : (activeRun ? 'LIVE WHATSAPP' : 'SIAGA')}
              </span>
              <span className="hud-text">{activeHeadline}</span>
            </div>

            {stream.liveArrivalNotice && (
              <div className="live-arrival-banner" role="status">
                <span>{stream.liveArrivalNotice}</span>
                <button
                  type="button"
                  className="banner-cta"
                  onClick={() => stream.switchMode('live')}
                >
                  Lihat Live
                </button>
                <button
                  type="button"
                  className="banner-dismiss"
                  aria-label="Tutup pemberitahuan"
                  onClick={stream.dismissLiveNotice}
                >
                  Tutup
                </button>
              </div>
            )}
          </div>

          {stream.mode === 'simulation' && (
            <SimulationControls
              activeScenarioId={stream.activeScenarioId}
              simPlaying={stream.simPlaying}
              onRunScenario={stream.runSimulation}
              onStopSimulation={stream.stopSimulation}
              onBackToLive={() => stream.switchMode('live')}
            />
          )}
        </main>

        <InspectorPanel
          open={inspectorOpen}
          isDrawerMode={!isDesktop}
          mode={stream.mode}
          connection={stream.connection}
          connectionError={stream.connectionError}
          snapshot={stream.snapshot}
          activeRun={activeRun}
          selectedStage={selectedStage}
          onClose={() => setInspectorOpen(false)}
          onRetryConnection={stream.retryConnection}
          onStartQuickSimulation={() => stream.runSimulation()}
          onReplayRun={stream.replayRealRun}
        />
      </div>

      <StageStepper
        activeRun={activeRun}
        selectedStage={selectedStage}
        onSelectStage={handleSelectStage}
      />
    </div>
  );
}
export default App;
