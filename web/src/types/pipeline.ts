export type StageId =
  | 'ingress'
  | 'queue'
  | 'gate'
  | 'multimodal'
  | 'context'
  | 'llm'
  | 'tools'
  | 'delivery';

export type StagePhase =
  | 'started'
  | 'progress'
  | 'bypassed'
  | 'waiting'
  | 'completed'
  | 'failed';

export type ScopeType = 'personal' | 'group' | 'system';

export type ThemeMode = 'dark' | 'light';

export type CameraPreset = 'follow' | 'overview' | 'core';

export type AppMode = 'live' | 'simulation';

export type ConnectionState = 'connecting' | 'live' | 'error';

export interface PipelineEventMeta {
  inputKind?: string;
  mediaKind?: string;
  extractionMode?: string;
  visualMode?: string;
  taskClass?: string;
  modelId?: string;
  modelTier?: string;
  escalatedFromTier?: string;
  fallbackFromModel?: string;
  toolName?: string;
  toolGroup?: string;
  outputMode?: string;
  slashCommand?: string;
  errorCategory?: string;
  wahaStatus?: string;
  approvalStatus?: string;
  priority?: number;
  attempts?: number;
  round?: number;
  maxRounds?: number;
  toolCount?: number;
  toolSchemaCount?: number;
  chunks?: number;
  durationMs?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  memoryCount?: number;
  projectCount?: number;
  docCount?: number;
  charCount?: number;
  queuePending?: number;
  queueProcessing?: number;
  queueFailed?: number;
  queueDead?: number;
  frameCount?: number;
  isGroup?: boolean;
  isFastPath?: boolean;
  ttsUsed?: boolean;
  parallel?: boolean;
  pendingApproval?: boolean;
  terminal?: boolean;
  bypassed?: boolean;
  replayed?: boolean;
  postTurn?: boolean;
  parallelTools?: string[];
  toolGroups?: string[];
}

export interface PipelineEvent {
  seq: number;
  ts: string;
  runId: string;
  stage: StageId;
  phase: StagePhase;
  label: string;
  chatRef: string;
  scope: ScopeType;
  meta: PipelineEventMeta;
}

export interface StageStateSummary {
  phase: StagePhase;
  label: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  meta: PipelineEventMeta;
}

export interface PipelineRun {
  runId: string;
  chatRef: string;
  scope: ScopeType;
  startedAt: string;
  updatedAt: string;
  currentStage: StageId;
  status: 'running' | 'waiting_approval' | 'completed' | 'failed';
  inputKind: string | null;
  taskClass: string | null;
  modelTier: string | null;
  modelId: string | null;
  outputMode: string | null;
  ttsUsed: boolean;
  hydrated?: boolean;
  simulated?: boolean;
  stages: Partial<Record<StageId, StageStateSummary>>;
  timeline: Array<{
    seq: number;
    ts: string;
    stage: StageId;
    phase: StagePhase;
    label: string;
    meta: PipelineEventMeta;
  }>;
}

export interface QueueStats {
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  deadCount: number;
  completedCount: number;
  oldestPendingAt: string | null;
}

export interface TelemetrySummary24h {
  windowHours: number;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  byTier: Record<string, {
    calls: number;
    successCalls: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
  }>;
}

export interface VisualizerSnapshot {
  service: {
    name: string;
    version: string;
    uptimeSec: number;
  };
  waha: {
    session: string;
    status: string;
    healthy: boolean;
  };
  worker: {
    activeCount: number;
    maxConcurrentJobs: number;
    healthy: boolean;
    queue: QueueStats | null;
  };
  telemetry24h: TelemetrySummary24h;
  activeRuns: PipelineRun[];
  recentRuns: PipelineRun[];
  recentEvents: PipelineEvent[];
}

export interface StageDefinition {
  id: StageId;
  index: number;
  shortName: string;
  name: string;
  sourceModule: string;
  roleSummary: string;
  technicalDetails: string;
  position3D: [number, number, number];
  accentRole: 'transport' | 'cognition';
}

export interface SimulationStep {
  delayMs: number;
  stage: StageId;
  phase: StagePhase;
  label: string;
  meta: PipelineEventMeta;
  runCompleted?: boolean;
}

export interface SimulationScenario {
  id: string;
  title: string;
  shortTitle: string;
  scope: ScopeType;
  inputKind: string;
  summary: string;
  steps: SimulationStep[];
}
