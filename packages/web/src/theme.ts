/**
 * Loads pi TUI theme JSON files (same files the interactive mode uses: built-in
 * dark/light plus any custom themes the server lists) and applies them as CSS
 * custom properties (--pi-<colorName>).
 */

import { signal } from "@preact/signals";

interface ThemeJson {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
	export?: {
		pageBg?: string;
		cardBg?: string;
		infoBg?: string;
	};
}

const THEME_STORAGE_KEY = "pi-web-theme";

export const themeName = signal("dark");
export const availableThemes = signal<string[]>(["dark", "light"]);

// Standard xterm 256-color palette conversion for themes that use color indices.
function ansi256ToHex(index: number): string {
	const base16 = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) return base16[index];
	if (index < 232) {
		const i = index - 16;
		const r = Math.floor(i / 36);
		const g = Math.floor((i % 36) / 6);
		const b = i % 6;
		const channel = (v: number) => (v === 0 ? 0 : v * 40 + 55);
		const hex = (v: number) => channel(v).toString(16).padStart(2, "0");
		return `#${hex(r)}${hex(g)}${hex(b)}`;
	}
	const gray = (index - 232) * 10 + 8;
	const hex = gray.toString(16).padStart(2, "0");
	return `#${hex}${hex}${hex}`;
}

function resolveColor(theme: ThemeJson, value: string | number, seen: Set<string>): string | undefined {
	if (typeof value === "number") return ansi256ToHex(value);
	if (value === "") return undefined;
	if (value.startsWith("#")) return value;
	const vars = theme.vars ?? {};
	if (value in vars && !seen.has(value)) {
		seen.add(value);
		return resolveColor(theme, vars[value], seen);
	}
	return undefined;
}

async function loadAvailableThemes(): Promise<void> {
	try {
		const response = await fetch("/themes");
		if (!response.ok) return;
		const data = (await response.json()) as { themes?: unknown };
		if (Array.isArray(data.themes) && data.themes.length > 0 && data.themes.every((t) => typeof t === "string")) {
			availableThemes.value = data.themes as string[];
		}
	} catch {
		// Older servers and the dev bridge may not list themes; keep defaults
	}
}

/** Light is the app's default look (see docs/screenshot2.png reference); dark is opt-in via the status strip's theme select. */
function defaultThemeName(themes: string[]): string {
	return themes.includes("light") ? "light" : themes[0];
}

export async function initTheme(): Promise<void> {
	await loadAvailableThemes();
	const themes = availableThemes.value;
	const stored = localStorage.getItem(THEME_STORAGE_KEY);
	const name = stored && themes.includes(stored) ? stored : defaultThemeName(themes);
	await applyTheme(name);
}

export async function applyTheme(name: string): Promise<void> {
	const response = await fetch(`/theme/${encodeURIComponent(name)}.json`);
	if (!response.ok) {
		throw new Error(`Failed to load theme: ${response.status}`);
	}
	const theme = (await response.json()) as ThemeJson;
	const root = document.documentElement;
	const style = root.style;

	// Remove previously applied theme variables
	for (const property of [...style]) {
		if (property.startsWith("--pi-")) {
			style.removeProperty(property);
		}
	}

	for (const [colorName, value] of Object.entries(theme.colors)) {
		const resolved = resolveColor(theme, value, new Set());
		if (resolved) {
			style.setProperty(`--pi-${colorName}`, resolved);
		}
	}
	if (theme.export?.pageBg) {
		style.setProperty("--pi-pageBg", theme.export.pageBg);
	}
	if (theme.export?.cardBg) {
		style.setProperty("--pi-cardBg", theme.export.cardBg);
	}

	const isLight = /light/i.test(name);
	root.style.colorScheme = isLight ? "light" : "dark";
	// Drives the app chrome tokens in style.css (--bg/--text/--accent/...),
	// independent of the --pi-* TUI theme colors applied above.
	root.dataset.theme = isLight ? "light" : "dark";
	localStorage.setItem(THEME_STORAGE_KEY, name);
	themeName.value = name;
}
