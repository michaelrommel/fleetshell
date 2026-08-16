// src/lib/theme.ts  (shared, client + server safe)
export const THEMES = ['nucleus', 'gruvbox'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'nucleus';

export function isTheme(v: unknown): v is Theme {
	return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}
