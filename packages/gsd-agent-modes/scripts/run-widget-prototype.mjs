#!/usr/bin/env node
// PROTOTYPE runner - compare compact /gsd auto progress widget options.
// Usage: pnpm run prototype:tui-widget [-- all|recommended|current-small|horizontal-bar|split-ribbon|dense-grid]
// Env: PROTOTYPE_WIDTH=<cols>  PROTOTYPE_THEME=dark|light

import stripAnsi from "strip-ansi";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import {
	WIDGET_PROTOTYPES,
	RECOMMENDED_WIDGET_PROTOTYPE_ID,
	lineStats,
	listWidgetPrototypeIds,
	renderWidgetPrototypeBanner,
	resolveWidgetPrototypeSet,
} from "../src/modes/interactive/components/__prototype__/gsd-widget-prototype.ts";

function resolveWidth() {
	if (process.env.PROTOTYPE_WIDTH) {
		const n = Number(process.env.PROTOTYPE_WIDTH);
		if (Number.isFinite(n) && n > 0) return Math.floor(n);
	}
	const envCols = Number(process.env.COLUMNS);
	const cols =
		(process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : undefined) ??
		(Number.isFinite(envCols) && envCols > 0 ? envCols : 120);
	return Math.max(40, Math.floor(cols));
}

const themeName = process.env.PROTOTYPE_THEME === "light" ? "light" : "dark";
initTheme(themeName, false);

const width = resolveWidth();
const arg = process.argv.slice(2).find((value) => value !== "--") ?? "all";
const prototypes = resolveWidgetPrototypeSet(arg);

for (const prototype of prototypes) {
	const rendered = prototype.render(width);
	const stats = lineStats(rendered.map((line) => stripAnsi(line)));

	process.stdout.write(renderWidgetPrototypeBanner(prototype, width).join("\n"));
	process.stdout.write("\n");
	process.stdout.write(rendered.join("\n"));
	process.stdout.write("\n\n");
	process.stdout.write(
		`  lines: ${stats.total} total · ${stats.nonBlank} content · ${stats.blank} blank (${stats.total ? Math.round((stats.blank / stats.total) * 100) : 0}% air)\n`,
	);
	process.stdout.write("\n");
}

if (prototypes.length > 1) {
	process.stdout.write(`Rendered at ${width} columns.\n\n`);
	process.stdout.write("Widget comparison:\n");
	for (const prototype of WIDGET_PROTOTYPES) {
		const stats = lineStats(prototype.render(width).map((line) => stripAnsi(line)));
		const mark = prototype.id === RECOMMENDED_WIDGET_PROTOTYPE_ID ? "★" : " ";
		process.stdout.write(`  ${mark} ${prototype.id.padEnd(16)} ${String(stats.total).padStart(3)} lines (${stats.blank} blank)\n`);
	}
	process.stdout.write("\n");
	process.stdout.write(`Recommended: pnpm run prototype:tui-widget -- ${RECOMMENDED_WIDGET_PROTOTYPE_ID}\n`);
	process.stdout.write(`IDs: ${listWidgetPrototypeIds().join(", ")}\n`);
}
