import { STAGE_DEFINITIONS } from '../data/stages';
import type { PipelineRun, StageId } from '../types/pipeline';

interface WebGLFallbackProps {
  activeRun: PipelineRun | null;
  selectedStage: StageId;
  onSelectStage: (stageId: StageId) => void;
}

export function WebGLFallback({ activeRun, selectedStage, onSelectStage }: WebGLFallbackProps) {
  return (
    <div className="webgl-fallback" role="region" aria-label="Diagram alur 2D fallback">
      <p className="fallback-note">
        Perangkat atau browser Anda tidak mendukung konteks WebGL 3D. Menampilkan peta alur interaktif 2D sebagai alternatif.
      </p>
      <div className="fallback-grid">
        {STAGE_DEFINITIONS.map((def) => {
          const st = activeRun?.stages?.[def.id];
          const phase = st?.phase || 'idle';
          const selected = selectedStage === def.id;
          return (
            <button
              key={def.id}
              type="button"
              className={`fallback-node phase-${phase} ${selected ? 'is-selected' : ''}`}
              onClick={() => onSelectStage(def.id)}
            >
              <span className="fallback-num">{def.index}</span>
              <span className="fallback-name">{def.shortName}</span>
              <span className="fallback-status">{st?.label || 'Siaga'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
