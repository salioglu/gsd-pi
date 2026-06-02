// PROTOTYPE - throwaway /gsd auto progress widget layout options.
// Question: can the widget stay small while using terminal width horizontally?
// Run: pnpm run prototype:tui-widget [-- current-small|horizontal-bar|split-ribbon|dense-grid|all]

import { alignRight, padRight, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { theme, type ThemeColor } from "@gsd/pi-coding-agent/theme/theme.js";

export type WidgetPrototypeId = "current-small" | "horizontal-bar" | "split-ribbon" | "dense-grid";

export interface WidgetPrototype {
	id: WidgetPrototypeId;
	label: string;
	tagline: string;
	render: (width: number) => string[];
}

const SAMPLE = {
	mode: "AUTO",
	state: "running",
	health: "green",
	elapsed: "1h 42m",
	eta: "18m left",
	phase: "execute-task",
	verb: "Execute",
	milestone: "M004",
	slice: "S02",
	unit: "T03",
	title: "Compare horizontal dashboard density",
	slicesDone: 2,
	slicesTotal: 5,
	tasksDone: 2,
	tasksTotal: 4,
	tokens: "182k",
	cost: "$1.83",
};

const RECOMMENDED_WIDGET_PROTOTYPE_ID: WidgetPrototypeId = "dense-grid";
export { RECOMMENDED_WIDGET_PROTOTYPE_ID };

function lineStats(lines: string[]): { total: number; blank: number; nonBlank: number } {
	const total = lines.length;
	const blank = lines.filter((line) => line.trim().length === 0).length;
	return { total, blank, nonBlank: total - blank };
}

export { lineStats };

function padLine(line: string, width: number): string {
	return padRight(truncateToWidth(line, width, ""), width);
}

function rule(width: number, color: ThemeColor = "borderMuted"): string {
	return theme.fg(color, "─".repeat(Math.max(1, width)));
}

function dim(text: string): string {
	return theme.fg("dim", text);
}

function accent(text: string): string {
	return theme.fg("accent", text);
}

function success(text: string): string {
	return theme.fg("success", text);
}

function text(textValue: string): string {
	return theme.fg("text", textValue);
}

function label(textValue: string, color: ThemeColor = "borderAccent"): string {
	return theme.fg(color, theme.bold(textValue.toUpperCase()));
}

function progressBar(width: number): string {
	const done = SAMPLE.slicesDone;
	const total = SAMPLE.slicesTotal;
	const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
	return `${success("█".repeat(filled))}${dim("░".repeat(Math.max(0, width - filled)))}`;
}

function metric(name: string, value: string, width: number): string {
	const raw = `${dim(name)} ${text(value)}`;
	return truncateToWidth(raw, width, "…");
}

function column(content: string, width: number): string {
	return padRight(truncateToWidth(content, width, "…"), width);
}

function fitColumns(width: number, parts: string[]): string {
	if (parts.length === 0) return "";
	const gap = dim(" │ ");
	const gapWidth = visibleWidth(gap) * (parts.length - 1);
	const available = Math.max(parts.length * 8, width - gapWidth);
	const base = Math.floor(available / parts.length);
	let remaining = available - base * parts.length;
	const cols = parts.map((part) => {
		const w = base + (remaining > 0 ? 1 : 0);
		remaining--;
		return column(part, w);
	});
	return truncateToWidth(cols.join(gap), width, "…");
}

function stateLine(id: WidgetPrototypeId, width: number, renderedLineCount: number): string {
	const state = [
		`variant=${id}`,
		"mode=small-prototype",
		`width=${width}`,
		`lines=${renderedLineCount}`,
		`unit=${SAMPLE.milestone}/${SAMPLE.slice}/${SAMPLE.unit}`,
	];
	return padLine(dim(`STATE ${state.join(" ")}`), width);
}

function actionTarget(maxWidth: number): string {
	return truncateToWidth(`${SAMPLE.unit}: ${SAMPLE.title}`, Math.max(8, maxWidth), "…");
}

function renderCurrentSmall(width: number): string[] {
	const pad = "  ";
	const lines: string[] = [];
	lines.push(rule(width));
	lines.push(alignRight(
		`${pad}${accent("◒")} ${accent(theme.bold("GSD"))} ${success(SAMPLE.mode)} ${success(SAMPLE.state)}`,
		dim(`${SAMPLE.elapsed} · ${SAMPLE.eta}`),
		width,
	));
	lines.push("");
	lines.push(alignRight(
		`${pad}${accent("▸")} ${accent(SAMPLE.verb)}  ${text(actionTarget(Math.floor(width * 0.58)))}`,
		dim(SAMPLE.phase),
		width,
	));
	const barWidth = Math.max(6, Math.min(18, Math.floor(width * 0.25)));
	lines.push(`${pad}${progressBar(barWidth)} ${text(`${SAMPLE.slicesDone}`)}${dim(`/${SAMPLE.slicesTotal} slices · task `)}${accent(String(SAMPLE.tasksDone + 1))}${dim(`/${SAMPLE.tasksTotal}`)}`);
	lines.push(rule(width));
	lines.push(stateLine("current-small", width, lines.length + 1));
	return lines.map((line) => padLine(line, width));
}

function renderHorizontalBar(width: number): string[] {
	const lines: string[] = [];
	const left = `${accent("◒ GSD")} ${success(SAMPLE.mode)} ${dim("·")} ${success(SAMPLE.state)} ${dim("·")} ${text(`${SAMPLE.verb} ${actionTarget(Math.floor(width * 0.45))}`)}`;
	const right = dim(`${SAMPLE.phase} · ${SAMPLE.elapsed} · ${SAMPLE.eta}`);
	lines.push(rule(width, "borderAccent"));
	lines.push(alignRight(left, right, width));

	const barWidth = Math.max(8, Math.min(16, Math.floor(width * 0.14)));
	const progressLeft = `${progressBar(barWidth)} ${text(`${SAMPLE.slicesDone}/${SAMPLE.slicesTotal}`)}${dim(" slices")} ${dim("· task ")}${accent(String(SAMPLE.tasksDone + 1))}${dim(`/${SAMPLE.tasksTotal}`)}`;
	const rightBudget = Math.max(20, width - visibleWidth(progressLeft) - 4);
	const progressRight = truncateToWidth(
		`${metric("tokens", SAMPLE.tokens, 18)} ${dim("·")} ${metric("cost", SAMPLE.cost, 12)}`,
		rightBudget,
		"…",
	);
	lines.push(alignRight(progressLeft, progressRight, width));
	lines.push(rule(width, "borderAccent"));
	lines.push(stateLine("horizontal-bar", width, lines.length + 1));
	return lines.map((line) => padLine(line, width));
}

function renderSplitRibbon(width: number): string[] {
	const lines: string[] = [];
	const title = `${accent("GSD")} ${success(SAMPLE.mode)} ${dim("·")} ${SAMPLE.milestone}/${SAMPLE.slice}/${SAMPLE.unit}`;
	const time = dim(`${SAMPLE.elapsed} · ${SAMPLE.eta}`);
	lines.push(rule(width));
	lines.push(alignRight(title, time, width));

	const actionWidth = Math.max(18, Math.floor(width * 0.42));
	const phaseWidth = Math.max(14, Math.floor(width * 0.18));
	const progressWidth = Math.max(22, Math.floor(width * 0.22));
	const action = `${label("work")} ${text(actionTarget(actionWidth))}`;
	const phase = `${label("phase", "border")} ${dim(SAMPLE.phase)}`;
	const progress = `${label("progress")} ${progressBar(Math.max(8, progressWidth - 18))} ${text(`${SAMPLE.slicesDone}/${SAMPLE.slicesTotal}`)}`;
	const run = `${label("run", "border")} ${dim(`${SAMPLE.tokens} · ${SAMPLE.cost}`)}`;
	lines.push(fitColumns(width, [action, phase, progress, run]));
	lines.push(rule(width));
	lines.push(stateLine("split-ribbon", width, lines.length + 1));
	return lines.map((line) => padLine(line, width));
}

function renderDenseGrid(width: number): string[] {
	const lines: string[] = [];
	const rowOne = fitColumns(width, [
		`${label("status", "border")} ${success(`${SAMPLE.mode} ${SAMPLE.state}`)}`,
		`${label("unit")} ${text(`${SAMPLE.milestone}/${SAMPLE.slice}/${SAMPLE.unit}`)}`,
		`${label("spend", "border")} ${dim(`${SAMPLE.tokens} · ${SAMPLE.cost}`)}`,
		`${label("time")} ${dim(`${SAMPLE.elapsed} · ${SAMPLE.eta}`)}`,
	]);
	const rowTwo = fitColumns(width, [
		`${label("phase", "border")} ${dim(SAMPLE.phase)}`,
		`${label("work")} ${text(actionTarget(Math.floor(width * 0.28)))}`,
		`${label("task", "border")} ${accent(String(SAMPLE.tasksDone + 1))}${dim(`/${SAMPLE.tasksTotal}`)}`,
		`${label("slice")} ${progressBar(Math.max(8, Math.min(16, Math.floor(width * 0.16))))} ${text(`${SAMPLE.slicesDone}/${SAMPLE.slicesTotal}`)}`,
	]);
	lines.push(rule(width, "borderAccent"));
	lines.push(rowOne);
	lines.push(rowTwo);
	lines.push(rule(width, "borderAccent"));
	lines.push(stateLine("dense-grid", width, lines.length + 1));
	return lines.map((line) => padLine(line, width));
}

export const WIDGET_PROTOTYPES: WidgetPrototype[] = [
	{
		id: "current-small",
		label: "A · Current small",
		tagline: "Baseline: existing small mode shape, vertical action/progress stack",
		render: renderCurrentSmall,
	},
	{
		id: "horizontal-bar",
		label: "B · Horizontal bar",
		tagline: "3-line widget, action + status use the full terminal width",
		render: renderHorizontalBar,
	},
	{
		id: "split-ribbon",
		label: "C · Split ribbon",
		tagline: "Four labeled columns without duplicating footer commands",
		render: renderSplitRibbon,
	},
	{
		id: "dense-grid",
		label: "D · Dense grid",
		tagline: "Selected: two metric rows, maximum scan data without growing height",
		render: renderDenseGrid,
	},
];

export function getWidgetPrototype(id: string): WidgetPrototype {
	const found = WIDGET_PROTOTYPES.find((prototype) => prototype.id === id);
	if (!found) {
		throw new Error(`Unknown widget prototype: ${id}. Options: ${WIDGET_PROTOTYPES.map((p) => p.id).join(", ")}`);
	}
	return found;
}

export function resolveWidgetPrototypeSet(arg: string): WidgetPrototype[] {
	if (arg === "all") return WIDGET_PROTOTYPES;
	if (arg === "recommended") return [getWidgetPrototype(RECOMMENDED_WIDGET_PROTOTYPE_ID)];
	return [getWidgetPrototype(arg)];
}

export function listWidgetPrototypeIds(): WidgetPrototypeId[] {
	return WIDGET_PROTOTYPES.map((prototype) => prototype.id);
}

export function renderWidgetPrototypeBanner(prototype: WidgetPrototype, width: number): string[] {
	const labelText = `${prototype.label}  ${prototype.id === RECOMMENDED_WIDGET_PROTOTYPE_ID ? "★ " : ""}${prototype.tagline}`;
	return [
		rule(width, prototype.id === RECOMMENDED_WIDGET_PROTOTYPE_ID ? "borderAccent" : "borderMuted"),
		padLine(labelText, width),
		rule(width, prototype.id === RECOMMENDED_WIDGET_PROTOTYPE_ID ? "borderAccent" : "borderMuted"),
	];
}
