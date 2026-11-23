import type { AppMode, CameraPreset, ConnectionState, ThemeMode } from '../types/pipeline';
import { IconMoon, IconPanel, IconPause, IconPlay, IconSun } from './Icons';

interface TopBarProps {
  connection: ConnectionState;
  wahaStatus: string | null;
  mode: AppMode;
  paused: boolean;
  cameraPreset: CameraPreset;
  theme: ThemeMode;
  inspectorOpen: boolean;
  onSwitchMode: (mode: AppMode) => void;
  onTogglePause: () => void;
  onChangeCameraPreset: (preset: CameraPreset) => void;
  onToggleTheme: () => void;
  onToggleInspector: () => void;
}

export function TopBar({
  connection,
  wahaStatus,
  mode,
  paused,
  cameraPreset,
  theme,
  inspectorOpen,
  onSwitchMode,
  onTogglePause,
  onChangeCameraPreset,
  onToggleTheme,
  onToggleInspector
}: TopBarProps) {
  const connLabel =
    connection === 'live'
      ? 'SSE Live'
      : connection === 'connecting'
        ? 'Menghubungkan'
        : 'Terputus';

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <h1 className="brand-title">Bubu AI</h1>
        <span className="brand-sub">Observatorium Alur 3D</span>
        <div
          className={`status-indicator status-${connection}`}
          title={wahaStatus ? `Status WAHA: ${wahaStatus}` : undefined}
        >
          <span className="status-dot" aria-hidden="true" />
          <span className="status-text">{connLabel}</span>
          {wahaStatus && <span className="status-waha">WAHA {wahaStatus}</span>}
        </div>
      </div>

      <div className="topbar-controls">
        <div className="segmented-group" role="group" aria-label="Mode visualisasi">
          <button
            type="button"
            className={`seg-btn ${mode === 'live' ? 'is-active' : ''}`}
            aria-pressed={mode === 'live'}
            onClick={() => onSwitchMode('live')}
          >
            Live WhatsApp
          </button>
          <button
            type="button"
            className={`seg-btn ${mode === 'simulation' ? 'is-active' : ''}`}
            aria-pressed={mode === 'simulation'}
            onClick={() => onSwitchMode('simulation')}
          >
            Simulasi
          </button>
        </div>

        <div className="segmented-group camera-group" role="group" aria-label="Preset kamera 3D">
          {([
            ['follow', 'Ikuti'],
            ['overview', 'Panorama'],
            ['core', 'Inti AI']
          ] as const).map(([preset, label]) => (
            <button
              key={preset}
              type="button"
              className={`seg-btn ${cameraPreset === preset ? 'is-active' : ''}`}
              aria-pressed={cameraPreset === preset}
              onClick={() => onChangeCameraPreset(preset)}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="action-btn"
          onClick={onTogglePause}
          aria-label={paused ? 'Putar animasi 3D' : 'Jeda animasi 3D'}
        >
          {paused ? <IconPlay /> : <IconPause />}
          <span className="btn-label">{paused ? 'Putar' : 'Jeda'}</span>
        </button>

        <button
          type="button"
          className="action-btn"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'}
        >
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
          <span className="btn-label">{theme === 'dark' ? 'Terang' : 'Gelap'}</span>
        </button>

        <button
          type="button"
          className={`action-btn ${inspectorOpen ? 'is-toggled' : ''}`}
          aria-expanded={inspectorOpen}
          aria-controls="inspector-drawer"
          onClick={onToggleInspector}
        >
          <IconPanel />
          <span className="btn-label">Inspektor</span>
        </button>
      </div>
    </header>
  );
}
