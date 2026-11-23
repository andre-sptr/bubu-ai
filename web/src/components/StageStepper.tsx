import { STAGE_DEFINITIONS } from '../data/stages';
import type { PipelineRun, StageId, StagePhase } from '../types/pipeline';
import { IconAlert, IconBypass, IconCheck, IconClock } from './Icons';

interface StageStepperProps {
  activeRun: PipelineRun | null;
  selectedStage: StageId;
  onSelectStage: (stageId: StageId) => void;
}

function phaseText(phase: StagePhase | 'idle'): string {
  switch (phase) {
    case 'started':
    case 'progress':
      return 'Aktif';
    case 'waiting':
      return 'Persetujuan';
    case 'completed':
      return 'Selesai';
    case 'bypassed':
      return 'Dilewati';
    case 'failed':
      return 'Gagal';
    default:
      return 'Siaga';
  }
}

function PhaseGlyph({ phase }: { phase: StagePhase | 'idle' }) {
  if (phase === 'completed') return <IconCheck />;
  if (phase === 'failed') return <IconAlert />;
  if (phase === 'bypassed') return <IconBypass />;
  if (phase === 'waiting') return <IconClock />;
  return null;
}

export function StageStepper({ activeRun, selectedStage, onSelectStage }: StageStepperProps) {
  return (
    <nav aria-label="Tahap pemrosesan Bubu AI" className="stage-stepper">
      <ol className="stepper-list">
        {STAGE_DEFINITIONS.map((def) => {
          const stageSummary = activeRun?.stages?.[def.id];
          const phase: StagePhase | 'idle' = stageSummary?.phase || 'idle';
          const isSelected = selectedStage === def.id;
          const isCurrent = activeRun?.currentStage === def.id && activeRun?.status === 'running';
          const duration = stageSummary?.durationMs;

          return (
            <li key={def.id} className="stepper-item">
              <button
                type="button"
                className={`step-btn phase-${phase} ${isSelected ? 'is-selected' : ''} ${isCurrent ? 'is-current' : ''}`}
                aria-current={isSelected ? 'step' : undefined}
                onClick={() => onSelectStage(def.id)}
              >
                <span className="step-head">
                  <span className="step-num">{def.index}</span>
                  <span className="step-name">{def.shortName}</span>
                </span>
                <span className="step-meta">
                  <span className="step-phase">
                    <PhaseGlyph phase={phase} />
                    <span>{phaseText(phase)}</span>
                  </span>
                  {duration !== null && duration !== undefined && (
                    <span className="step-ms">{duration}ms</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
