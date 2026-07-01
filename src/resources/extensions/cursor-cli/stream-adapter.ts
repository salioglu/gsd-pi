import { spawn } from "node:child_process";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
} from "@gsd/pi-ai";
import { createAssistantMessageEventStream } from "@gsd/pi-ai";

interface CursorAgentRunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
}

export interface CursorAgentRunPlan {
	command: string;
	args: string[];
}

export interface CursorAgentStreamOptions extends SimpleStreamOptions {
	_cursorAgentRunnerForTest?: (plan: CursorAgentRunPlan, options?: SimpleStreamOptions) => Promise<CursorAgentRunResult>;
}

type ExternalToolResult = NonNullable<ToolCall["externalResult"]>;

type ParsedCursorAgentLine =
	| { type: "text"; text: string }
	| { type: "tool_call"; toolCall: ToolCall }
	| { type: "tool_result"; toolCallId: string; result: ExternalToolResult }
	| { type: "usage"; usage: Partial<AssistantMessage["usage"]> }
	| { type: "error"; message: string }
	| { type: "ignore" };

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textBlocks(content: (TextContent | { type: string })[]): string {
	return content
		.map((block) => block.type === "text" ? (block as TextContent).text : `[${block.type} omitted]`)
		.join("\n");
}

function messageToText(message: Message): string {
	if (message.role === "user") {
		const content = typeof message.content === "string" ? message.content : textBlocks(message.content);
		return `User:\n${content}`;
	}

	if (message.role === "assistant") {
		const text = message.content
			.map((block) => {
				if (block.type === "text") return block.text;
				if (block.type === "thinking") return "[thinking omitted]";
				if (block.type === "toolCall") return `[tool call: ${block.name}]`;
				if (block.type === "serverToolUse") return `[server tool: ${block.name}]`;
				if (block.type === "webSearchResult") return "[web search result omitted]";
				return `[${(block as { type: string }).type} omitted]`;
			})
			.join("\n");
		return `Assistant:\n${text}`;
	}

	return `Tool result (${message.toolName}):\n${textBlocks(message.content)}`;
}

export function buildCursorPrompt(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt?.trim()) parts.push(`System instructions:\n${context.systemPrompt.trim()}`);
	if (context.messages.length > 0) parts.push(context.messages.map(messageToText).join("\n\n"));
	if (context.tools?.length) {
		parts.push(
			`The external Cursor agent may execute its own tools. ` +
			`If it reports tool calls, GSD will treat them as externally executed. ` +
			`Requested GSD tools: ${context.tools.map((tool) => tool.name).join(", ")}`,
		);
	}
	return parts.join("\n\n").trim();
}

export function buildCursorSpawnInvocation(
	command: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
): CursorAgentRunPlan {
	if (platform === "win32") return { command: "cmd", args: ["/c", command, ...args] };
	return { command, args };
}

export function buildCursorAgentRunPlan(
	modelId: string,
	prompt: string,
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): CursorAgentRunPlan {
	return buildCursorSpawnInvocation(
		process.env.CURSOR_AGENT_BIN?.trim() || "cursor-agent",
		["-p", prompt, "--output-format", "stream-json", "--model", modelId, "--workspace", cwd, "--trust"],
		platform,
	);
}

function runCursorAgent(plan: CursorAgentRunPlan, options?: SimpleStreamOptions): Promise<CursorAgentRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(plan.command, plan.args, {
			cwd: options?.cwd || process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			options?.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => {
			child.kill("SIGTERM");
			settle(() => reject(new Error("Request was aborted")));
		};

		if (options?.signal?.aborted) {
			onAbort();
			return;
		}
		options?.signal?.addEventListener("abort", onAbort);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => { stdout += chunk; });
		child.stderr?.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", (code, signal) => settle(() => resolve({ stdout, stderr, code, signal })));
	});
}

function stringValue(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => stringValue(objectValue(item)?.text, objectValue(item)?.content, item))
			.filter((item): item is string => Boolean(item))
			.join("\n");
	}
	const obj = objectValue(value);
	if (!obj) return "";
	return stringValue(obj.text, obj.content, obj.message, obj.result) ?? "";
}

function mapUsage(raw: Record<string, unknown>): Partial<AssistantMessage["usage"]> {
	const input = Number(raw.input_tokens ?? raw.input ?? raw.prompt_tokens ?? 0);
	const output = Number(raw.output_tokens ?? raw.output ?? raw.completion_tokens ?? 0);
	const cacheRead = Number(raw.cache_read_input_tokens ?? raw.cacheRead ?? 0);
	const cacheWrite = Number(raw.cache_creation_input_tokens ?? raw.cacheWrite ?? 0);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
	};
}

function normalizeToolArguments(input: unknown): Record<string, unknown> {
	return objectValue(input) ?? { input };
}

function normalizeToolResult(raw: Record<string, unknown>): ExternalToolResult {
	const text = extractText(raw.content ?? raw.result ?? raw.output);
	return {
		content: text ? [{ type: "text", text }] : [],
		isError: Boolean(raw.is_error ?? raw.isError ?? raw.error),
	};
}

export function parseCursorAgentLine(line: string): ParsedCursorAgentLine {
	const trimmed = line.trim();
	if (!trimmed) return { type: "ignore" };

	let event: Record<string, unknown>;
	try {
		event = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return { type: "text", text: trimmed };
	}

	const type = stringValue(event.type, event.event) ?? "";
	if (type === "error") {
		return { type: "error", message: stringValue(event.message, event.error) ?? "cursor_agent_error" };
	}

	if (type === "tool_call") {
		const id = stringValue(event.id, event.tool_call_id) ?? `cursor_tool_${Date.now()}`;
		const name = stringValue(event.name, event.tool_name) ?? "cursor_tool";
		return {
			type: "tool_call",
			toolCall: { type: "toolCall", id, name, arguments: normalizeToolArguments(event.input ?? event.arguments) },
		};
	}

	if (type === "tool_result") {
		return {
			type: "tool_result",
			toolCallId: stringValue(event.tool_call_id, event.id) ?? "",
			result: normalizeToolResult(event),
		};
	}

	if (type === "result") {
		const usage = objectValue(event.usage);
		return usage ? { type: "usage", usage: mapUsage(usage) } : { type: "ignore" };
	}

	const text = extractText(event.delta ?? event.text ?? event.content ?? objectValue(event.message)?.content ?? event.message);
	if (text) return { type: "text", text };

	const usage = objectValue(event.usage);
	if (usage) return { type: "usage", usage: mapUsage(usage) };

	return { type: "ignore" };
}

function createUsage(partial?: Partial<AssistantMessage["usage"]>): AssistantMessage["usage"] {
	const input = partial?.input ?? 0;
	const output = partial?.output ?? 0;
	const cacheRead = partial?.cacheRead ?? 0;
	const cacheWrite = partial?.cacheWrite ?? 0;
	return {
		...ZERO_USAGE,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheWrite,
		cost: { ...ZERO_USAGE.cost },
	};
}

function buildAssistantMessage(
	model: Model<Api>,
	content: AssistantMessage["content"],
	usage?: Partial<AssistantMessage["usage"]>,
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(usage),
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function emitDone(stream: AssistantMessageEventStream, message: AssistantMessage, text: string): void {
	stream.push({ type: "start", partial: { ...message, content: [] } });
	if (text) {
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
	}
	message.content.forEach((block, index) => {
		if (block.type !== "toolCall") return;
		stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
	});
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
}

function emitError(stream: AssistantMessageEventStream, model: Model<Api>, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const output = buildAssistantMessage(model, [], undefined, "error", message);
	stream.push({ type: "error", reason: "error", error: output });
	stream.end(output);
}

export function streamViaCursorAgent(
	model: Model<Api>,
	context: Context,
	options?: CursorAgentStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	queueMicrotask(async () => {
		try {
			const cwd = options?.cwd || process.cwd();
			const prompt = buildCursorPrompt(context);
			const plan = buildCursorAgentRunPlan(model.id, prompt, cwd);
			const run = options?._cursorAgentRunnerForTest ?? runCursorAgent;
			const result = await run(plan, options);

			if (result.code !== 0) {
				throw new Error((result.stderr || result.stdout || `cursor-agent exited with code ${result.code}`).trim());
			}

			let text = "";
			let usage: Partial<AssistantMessage["usage"]> | undefined;
			const toolCalls = new Map<string, ToolCall>();
			const content: AssistantMessage["content"] = [];

			for (const line of result.stdout.split(/\r?\n/)) {
				const parsed = parseCursorAgentLine(line);
				if (parsed.type === "ignore") continue;
				if (parsed.type === "error") throw new Error(parsed.message);
				if (parsed.type === "text") {
					text += parsed.text;
					continue;
				}
				if (parsed.type === "usage") {
					usage = { ...(usage ?? {}), ...parsed.usage };
					continue;
				}
				if (parsed.type === "tool_call") {
					toolCalls.set(parsed.toolCall.id, parsed.toolCall);
					content.push(parsed.toolCall);
					continue;
				}
				if (parsed.type === "tool_result") {
					const toolCall = toolCalls.get(parsed.toolCallId);
					if (toolCall) toolCall.externalResult = parsed.result;
				}
			}

			if (text) content.unshift({ type: "text", text });
			emitDone(stream, buildAssistantMessage(model, content, usage), text);
		} catch (error) {
			emitError(stream, model, error);
		}
	});

	return stream;
}
