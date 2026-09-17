export interface Settings {
  actionCam: 'off' | 'sometimes' | 'always';
  speed: 1 | 2;
  truth: boolean;      // Tabletop Truth overlay: bases, arcs, templates
  assist: boolean;     // ghost preview of your own maneuver while planning
  volume: number;
}

const KEY = 'holotable-settings';
const defaults: Settings = { actionCam: 'sometimes', speed: 1, truth: false, assist: true, volume: 0.6 };

export const settings: Settings = (() => {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { ...defaults }; }
})();

export function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ } }
