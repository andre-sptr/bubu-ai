import { SIMULATION_SCENARIOS } from '../data/simulations';

interface SimulationControlsProps {
  activeScenarioId: string;
  simPlaying: boolean;
  onRunScenario: (scenarioId: string) => void;
  onStopSimulation: () => void;
  onBackToLive: () => void;
}

export function SimulationControls({
  activeScenarioId,
  simPlaying,
  onRunScenario,
  onStopSimulation,
  onBackToLive
}: SimulationControlsProps) {
  return (
    <section className="sim-strip" aria-label="Pemilih skenario simulasi alur Bubu AI" tabIndex={0}>
      <div className="sim-badge">MODE SIMULASI</div>
      <div className="sim-buttons">
        {SIMULATION_SCENARIOS.map((scenario) => {
          const isSelected = scenario.id === activeScenarioId;
          return (
            <button
              key={scenario.id}
              type="button"
              className={`sim-btn ${isSelected ? 'is-selected' : ''}`}
              aria-pressed={isSelected}
              onClick={() => onRunScenario(scenario.id)}
            >
              {scenario.shortTitle}
            </button>
          );
        })}
      </div>
      <div className="sim-actions">
        {simPlaying && (
          <button type="button" className="sim-action-btn" onClick={onStopSimulation}>
            Hentikan
          </button>
        )}
        <button type="button" className="sim-action-btn primary" onClick={onBackToLive}>
          Kembali ke Live
        </button>
      </div>
    </section>
  );
}
