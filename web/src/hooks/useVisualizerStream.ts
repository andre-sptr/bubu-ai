import { useCallback, useEffect, useRef, useState } from 'react';
import { SIMULATION_SCENARIOS } from '../data/simulations';
import type {
  AppMode,
  ConnectionState,
  PipelineEvent,
  PipelineRun,
  StageId,
  VisualizerSnapshot
} from '../types/pipeline';

interface UseVisualizerStreamOptions {
  paused: boolean;
  onSceneEvent: (event: PipelineEvent) => void;
  onSceneSyncRun: (run: PipelineRun | null) => void;
  onSceneReset: () => void;
}

function buildRunFromEvent(prev: PipelineRun | null, ev: PipelineEvent, simulated = false): PipelineRun {
  const base: PipelineRun = prev && prev.runId === ev.runId
    ? {
        ...prev,
        stages: { ...prev.stages },
        timeline: [...prev.timeline]
      }
    : {
        runId: ev.runId,
        chatRef: ev.chatRef,
        scope: ev.scope,
        startedAt: ev.ts,
        updatedAt: ev.ts,
        currentStage: ev.stage,
        status: 'running',
        inputKind: ev.meta.inputKind || null,
        taskClass: ev.meta.taskClass || null,
        modelTier: ev.meta.modelTier || null,
        modelId: ev.meta.modelId || null,
        outputMode: ev.meta.outputMode || null,
        ttsUsed: Boolean(ev.meta.ttsUsed),
        simulated,
        stages: {},
        timeline: []
      };

  base.updatedAt = ev.ts;
  if (!ev.meta.postTurn) {
    base.currentStage = ev.stage;
  }
  if (ev.meta.inputKind && !base.inputKind) base.inputKind = ev.meta.inputKind;
  if (ev.meta.taskClass) base.taskClass = ev.meta.taskClass;
  if (ev.meta.modelTier) base.modelTier = ev.meta.modelTier;
  if (ev.meta.modelId) base.modelId = ev.meta.modelId;
  if (ev.meta.outputMode) base.outputMode = ev.meta.outputMode;
  if (ev.meta.ttsUsed !== undefined) base.ttsUsed = Boolean(ev.meta.ttsUsed);

  if (ev.phase === 'waiting') {
    base.status = 'waiting_approval';
  } else if (ev.phase === 'failed' && ev.meta.terminal !== false) {
    base.status = 'failed';
  } else if (ev.stage === 'delivery' && ev.phase === 'completed') {
    base.status = 'completed';
  } else if (base.status === 'waiting_approval' && (ev.phase === 'started' || ev.phase === 'completed')) {
    base.status = 'running';
  }

  const prevStage = base.stages[ev.stage];
  const isEnd = ev.phase === 'completed' || ev.phase === 'bypassed' || ev.phase === 'failed';
  base.stages[ev.stage] = {
    phase: ev.meta.postTurn && prevStage?.phase ? prevStage.phase : ev.phase,
    label: ev.label,
    startedAt: prevStage?.startedAt || ev.ts,
    completedAt: isEnd ? ev.ts : (prevStage?.completedAt || null),
    durationMs: ev.meta.durationMs ?? ev.meta.latencyMs ?? prevStage?.durationMs ?? null,
    meta: { ...(prevStage?.meta || {}), ...ev.meta }
  };

  base.timeline.push({
    seq: ev.seq,
    ts: ev.ts,
    stage: ev.stage,
    phase: ev.phase,
    label: ev.label,
    meta: ev.meta
  });
  if (base.timeline.length > 40) base.timeline.shift();

  if (ev.stage === 'delivery' && ev.phase === 'completed' && base.stages.queue?.phase === 'started') {
    base.stages.queue = {
      ...base.stages.queue,
      phase: 'completed',
      completedAt: ev.ts
    };
  }

  return base;
}

export function useVisualizerStream({
  paused,
  onSceneEvent,
  onSceneSyncRun,
  onSceneReset
}: UseVisualizerStreamOptions) {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<VisualizerSnapshot | null>(null);
  const [mode, setMode] = useState<AppMode>('live');
  const [liveRun, setLiveRun] = useState<PipelineRun | null>(null);
  const [simRun, setSimRun] = useState<PipelineRun | null>(null);
  const [activeScenarioId, setActiveScenarioId] = useState<string>(SIMULATION_SCENARIOS[1].id);
  const [simPlaying, setSimPlaying] = useState(false);
  const [liveArrivalNotice, setLiveArrivalNotice] = useState<string | null>(null);
  const [reconnectTick, setReconnectTick] = useState(0);

  const modeRef = useRef<AppMode>(mode);
  const pausedRef = useRef<boolean>(paused);
  const simTimersRef = useRef<number[]>([]);
  const simSeqRef = useRef(0);
  const onSceneEventRef = useRef(onSceneEvent);
  const onSceneSyncRunRef = useRef(onSceneSyncRun);
  const onSceneResetRef = useRef(onSceneReset);

  modeRef.current = mode;
  pausedRef.current = paused;
  onSceneEventRef.current = onSceneEvent;
  onSceneSyncRunRef.current = onSceneSyncRun;
  onSceneResetRef.current = onSceneReset;

  const clearSimTimers = useCallback(() => {
    for (const timer of simTimersRef.current) {
      window.clearTimeout(timer);
    }
    simTimersRef.current = [];
  }, []);

  const stopSimulation = useCallback(() => {
    clearSimTimers();
    setSimPlaying(false);
  }, [clearSimTimers]);

  const startEventTimeline = useCallback(
    (
      runId: string,
      chatRef: string,
      scope: 'personal' | 'group' | 'system',
      steps: Array<{
        delayMs: number;
        stage: StageId;
        phase: PipelineEvent['phase'];
        label: string;
        meta: PipelineEvent['meta'];
        runCompleted?: boolean;
      }>,
      simulated: boolean
    ) => {
      clearSimTimers();
      onSceneResetRef.current();
      setSimRun(null);
      setSimPlaying(true);

      let cumulativeDelay = 120;
      let currentRun: PipelineRun | null = null;

      steps.forEach((step, idx) => {
        cumulativeDelay += Math.max(80, step.delayMs);
        const timer = window.setTimeout(() => {
          const ev: PipelineEvent = {
            seq: ++simSeqRef.current,
            ts: new Date().toISOString(),
            runId,
            stage: step.stage,
            phase: step.phase,
            label: step.label,
            chatRef,
            scope,
            meta: step.meta
          };

          currentRun = buildRunFromEvent(currentRun, ev, simulated);
          if (step.runCompleted) {
            currentRun = { ...currentRun, status: currentRun.status === 'failed' ? 'failed' : 'completed' };
          }
          setSimRun(currentRun);
          onSceneEventRef.current(ev);

          if (idx === steps.length - 1) {
            setSimPlaying(false);
          }
        }, cumulativeDelay);
        simTimersRef.current.push(timer);
      });
    },
    [clearSimTimers]
  );

  const runSimulation = useCallback(
    (scenarioId?: string) => {
      const targetId = scenarioId || activeScenarioId;
      const scenario = SIMULATION_SCENARIOS.find((s) => s.id === targetId) || SIMULATION_SCENARIOS[0];
      setActiveScenarioId(scenario.id);
      setMode('simulation');
      setLiveArrivalNotice(null);

      const runId = `sim-${scenario.id.slice(0, 6)}-${Date.now().toString(36).slice(-4)}`;
      const chatRef = scenario.scope === 'group' ? 'GRP-sim0' : 'DM-sim0';
      startEventTimeline(runId, chatRef, scenario.scope, scenario.steps, true);
    },
    [activeScenarioId, startEventTimeline]
  );

  const replayRealRun = useCallback(
    (run: PipelineRun) => {
      if (!run || !run.timeline?.length) return;
      setMode('simulation');
      setLiveArrivalNotice(null);

      const steps = run.timeline.map((entry, idx) => ({
        delayMs: idx === 0 ? 0 : 480,
        stage: entry.stage,
        phase: entry.phase,
        label: entry.label,
        meta: entry.meta || {},
        runCompleted: idx === run.timeline.length - 1
      }));

      startEventTimeline(`replay-${run.runId}`, run.chatRef, run.scope, steps, false);
    },
    [startEventTimeline]
  );

  const switchMode = useCallback(
    (nextMode: AppMode) => {
      if (nextMode === 'live') {
        stopSimulation();
        setMode('live');
        setLiveArrivalNotice(null);
        if (liveRun) {
          onSceneSyncRunRef.current(liveRun);
        } else if (snapshot?.activeRuns?.[0]) {
          onSceneSyncRunRef.current(snapshot.activeRuns[0]);
        } else {
          onSceneResetRef.current();
        }
      } else {
        setMode('simulation');
        if (!simRun && !simPlaying) {
          runSimulation(activeScenarioId);
        } else if (simRun) {
          onSceneSyncRunRef.current(simRun);
        }
      }
    },
    [activeScenarioId, liveRun, runSimulation, simPlaying, simRun, snapshot, stopSimulation]
  );

  const retryConnection = useCallback(() => {
    setConnection('connecting');
    setConnectionError(null);
    setReconnectTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let retryTimer: number | null = null;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      setConnection('connecting');
      source = new EventSource('/api/visualizer/stream');

      source.addEventListener('snapshot', (rawEvent) => {
        if (closed) return;
        attempt = 0;
        setConnection('live');
        setConnectionError(null);
        try {
          const data = JSON.parse((rawEvent as MessageEvent).data) as VisualizerSnapshot;
          setSnapshot(data);
          const initialActive = data.activeRuns?.[0] || null;
          setLiveRun(initialActive);
          if (modeRef.current === 'live') {
            onSceneSyncRunRef.current(initialActive || data.recentRuns?.[0] || null);
          }
        } catch {
          setConnectionError('Format snapshot telemetri tidak valid.');
        }
      });

      source.addEventListener('stage', (rawEvent) => {
        if (closed) return;
        try {
          const ev = JSON.parse((rawEvent as MessageEvent).data) as PipelineEvent;
          setLiveRun((prev) => {
            const next = buildRunFromEvent(prev, ev, false);
            return next;
          });

          setSnapshot((prev) => {
            if (!prev) return prev;
            const updatedEvents = [...(prev.recentEvents || []), ev].slice(-40);
            const isTerminal =
              (ev.stage === 'delivery' && ev.phase === 'completed') ||
              (ev.stage === 'queue' && ev.phase === 'failed' && ev.meta.terminal);

            if (isTerminal) {
              const completedEntry = buildRunFromEvent(
                prev.activeRuns.find((r) => r.runId === ev.runId) || null,
                ev,
                false
              );
              const nextRecent = [
                completedEntry,
                ...prev.recentRuns.filter((r) => r.runId !== ev.runId)
              ].slice(0, 25);
              return {
                ...prev,
                activeRuns: prev.activeRuns.filter((r) => r.runId !== ev.runId),
                recentRuns: nextRecent,
                recentEvents: updatedEvents
              };
            }

            const existingIdx = prev.activeRuns.findIndex((r) => r.runId === ev.runId);
            const nextActive = [...prev.activeRuns];
            if (existingIdx >= 0) {
              nextActive[existingIdx] = buildRunFromEvent(nextActive[existingIdx], ev, false);
            } else {
              nextActive.unshift(buildRunFromEvent(null, ev, false));
            }
            return {
              ...prev,
              activeRuns: nextActive,
              recentEvents: updatedEvents
            };
          });

          if (modeRef.current === 'live') {
            onSceneEventRef.current(ev);
          } else {
            setLiveArrivalNotice(`Pesan WhatsApp nyata sedang diproses (${ev.chatRef})`);
          }
        } catch {
          // Ignore malformed event line safely.
        }
      });

      source.addEventListener('health', (rawEvent) => {
        if (closed) return;
        try {
          const payload = JSON.parse((rawEvent as MessageEvent).data) as {
            waha?: VisualizerSnapshot['waha'];
            worker?: VisualizerSnapshot['worker'];
          };
          setSnapshot((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              ...(payload.waha ? { waha: payload.waha } : {}),
              ...(payload.worker ? { worker: payload.worker } : {})
            };
          });
        } catch {
          // Ignore malformed health event.
        }
      });

      source.onerror = () => {
        if (closed) return;
        source?.close();
        source = null;
        setConnection('error');
        attempt += 1;
        const waitSec = Math.min(15, Math.pow(2, Math.min(4, attempt - 1)));
        setConnectionError(`Koneksi stream SSE terputus. Mencoba ulang dalam ${waitSec} detik.`);
        retryTimer = window.setTimeout(connect, waitSec * 1000);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [reconnectTick]);

  useEffect(() => {
    return () => clearSimTimers();
  }, [clearSimTimers]);

  const activeDisplayRun: PipelineRun | null =
    mode === 'simulation'
      ? simRun
      : (liveRun || snapshot?.activeRuns?.[0] || null);

  return {
    connection,
    connectionError,
    snapshot,
    mode,
    activeDisplayRun,
    activeScenarioId,
    simPlaying,
    liveArrivalNotice,
    switchMode,
    runSimulation,
    stopSimulation,
    replayRealRun,
    retryConnection,
    dismissLiveNotice: () => setLiveArrivalNotice(null)
  };
}
