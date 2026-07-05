/**
 * Orchestrator — LLM-powered agent for the #gsd-control Discord channel.
 *
 * Receives Discord messages, maintains conversation history, calls the
 * Anthropic messages API with 5 tool definitions (list_projects, start_session,
 * get_status, stop_session, get_session_detail), and sends the LLM's response
 * back to Discord.
 *
 * Uses the standard messages.create() tool-use loop (not betaZodTool helpers,
 * which don't exist in SDK v0.52). Zod schemas are used for input validation
 * at the tool execution layer.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { SessionManager } from './session-manager.js';
import type { ChannelManager } from './channel-manager.js';
import type { ProjectInfo } from './types.js';
import type { Logger } from './logger.js';
import {
  ORCHESTRATOR_TOOLS,
  executeOrchestratorTool,
  type OrchestratorToolContext,
} from './orchestrator-tools.js';

// ---------------------------------------------------------------------------
// API key resolution — requires ANTHROPIC_API_KEY env var
// Anthropic OAuth removed per TOS compliance (see docs/user-docs/claude-code-auth-compliance.md)
// ---------------------------------------------------------------------------

function resolveAnthropicApiKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required. Set it in your environment or run `gsd config`.',
    );
  }
  return apiKey;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  model: string;
  max_tokens: number;
  control_channel_id: string;
}

export interface OrchestratorDeps {
  sessionManager: SessionManager;
  channelManager: ChannelManager;
  scanProjects: () => Promise<ProjectInfo[]>;
  config: OrchestratorConfig;
  logger: Logger;
  ownerId: string;
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are GSD Control — a concise, capable orchestrator for managing GSD (Git Ship Done) coding agent sessions via Discord.

You have tools to list projects, start sessions, get status, stop sessions, and inspect session details. Use them to fulfill the user's requests.

Response guidelines:
- Be terse and direct. No filler, no performed enthusiasm.
- When reporting status, use bullet points with project name, status, duration, and cost.
- When starting a session, confirm with the project name and session ID.
- When stopping a session, confirm which session was stopped.
- If something fails, say what went wrong plainly.
- Use Discord markdown formatting (bold, code blocks) for readability.
- Never expose internal error stack traces to the user — summarize the issue.`;

// ---------------------------------------------------------------------------
// Conversation History Cap
// ---------------------------------------------------------------------------

const MAX_HISTORY = 30;

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly toolContext: OrchestratorToolContext;
  private client: Anthropic | null;
  private history: MessageParam[] = [];

  /**
   * @param deps - orchestrator dependencies (session manager, channel manager, etc.)
   * @param client - optional Anthropic client for testability; if omitted, created from env
   */
  constructor(deps: OrchestratorDeps, client?: Anthropic) {
    this.deps = deps;
    this.toolContext = {
      sessionManager: deps.sessionManager,
      scanProjects: deps.scanProjects,
      logger: deps.logger,
    };
    this.client = client ?? null;
  }

  /**
   * Lazily initialise the Anthropic client. Dynamic import handles K007 module resolution.
   * Requires ANTHROPIC_API_KEY environment variable.
   */
  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const apiKey = resolveAnthropicApiKey();
    const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
    this.client = new AnthropicSDK({ apiKey });
    return this.client;
  }

  /**
   * Handle an incoming Discord message. Entry point called by the bot's
   * message handler for every message in every channel.
   *
   * Guards: ignores bot messages, non-owner messages, and non-control-channel messages.
   */
  async handleMessage(message: DiscordMessageLike): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return;

    // Ignore non-control-channel messages
    if (message.channelId !== this.deps.config.control_channel_id) return;

    // Auth guard — only the owner can use the orchestrator
    if (message.author.id !== this.deps.ownerId) {
      this.deps.logger.debug('orchestrator auth rejected', { userId: message.author.id });
      return;
    }

    const content = message.content?.trim();
    if (!content) return;

    this.deps.logger.info('orchestrator message received', {
      userId: message.author.id,
      channelId: message.channelId,
      contentLength: content.length,
    });

    // Append user message to history
    this.history.push({ role: 'user', content });

    try {
      // Show typing indicator while processing
      await message.channel.sendTyping().catch(() => {});

      const responseText = await this.runAgentLoop();

      // Send response to Discord
      await message.channel.send(responseText);

      this.deps.logger.info('orchestrator response sent', {
        channelId: message.channelId,
        responseLength: responseText.length,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Invalidate cached client on auth errors so next call re-resolves OAuth token
      if (errorMsg.includes('authentication') || errorMsg.includes('apiKey') || errorMsg.includes('authToken') || errorMsg.includes('401')) {
        this.client = null;
      }

      this.deps.logger.error('orchestrator error', {
        error: errorMsg,
        userId: message.author.id,
        channelId: message.channelId,
      });

      // Send error feedback to Discord
      try {
        await message.channel.send('⚠️ Something went wrong processing your request.');
      } catch (sendErr) {
        this.deps.logger.warn('orchestrator error reply failed', {
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }

      // Still append a synthetic assistant message so history stays paired
      this.history.push({ role: 'assistant', content: '[error — see logs]' });
    }

    this.trimHistory();
  }

  /**
   * Run the tool-use loop: call messages.create(), execute any tool calls,
   * feed results back, repeat until the model produces a final text response.
   */
  private async runAgentLoop(): Promise<string> {
    const client = await this.getClient();
    const { model, max_tokens } = this.deps.config;

    let loopMessages: MessageParam[] = [...this.history];
    const maxIterations = 10; // safety valve

    for (let i = 0; i < maxIterations; i++) {
      const response = await client.messages.create({
        model,
        max_tokens,
        system: SYSTEM_PROMPT,
        tools: ORCHESTRATOR_TOOLS,
        messages: loopMessages,
      });

      // If the model stopped for end_turn (no tool calls), extract text and return
      if (response.stop_reason === 'end_turn' || response.stop_reason !== 'tool_use') {
        const textBlocks = response.content.filter(
          (b): b is TextBlock => b.type === 'text',
        );
        const finalText = textBlocks.map((b) => b.text).join('\n') || '(No response)';

        // Append assistant message to conversation history
        this.history.push({ role: 'assistant', content: finalText });

        return finalText;
      }

      // Model wants to use tools — execute them all
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );

      // Build tool results
      const toolResults: ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const result = await executeOrchestratorTool(
          this.toolContext,
          toolUse.name,
          toolUse.input as Record<string, unknown>,
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Append the assistant message (with tool_use blocks) and user tool_result message
      loopMessages = [
        ...loopMessages,
        { role: 'assistant', content: response.content as ContentBlockParam[] },
        { role: 'user', content: toolResults },
      ];
    }

    // If we hit max iterations, return a fallback
    return 'I hit the maximum number of tool iterations. Please try a simpler request.';
  }


  // ---------------------------------------------------------------------------
  // History management
  // ---------------------------------------------------------------------------

  /**
   * Trim conversation history to MAX_HISTORY entries.
   * Removes the oldest user+assistant pair from the front to keep pairs aligned.
   */
  private trimHistory(): void {
    while (this.history.length > MAX_HISTORY) {
      // Remove from front — two messages at a time to keep user/assistant pairs
      this.history.splice(0, 2);
    }
  }

  /**
   * Return a copy of the conversation history (for debugging / observability).
   */
  getHistory(): MessageParam[] {
    return [...this.history];
  }

  /**
   * Stop the orchestrator — clears history and nulls client reference.
   */
  stop(): void {
    this.history = [];
    this.client = null;
  }
}

// ---------------------------------------------------------------------------
// Discord message type (minimal interface for testability)
// ---------------------------------------------------------------------------

/**
 * Minimal Discord message interface — avoids importing discord.js directly,
 * making the orchestrator testable without full discord.js mocking.
 */
export interface DiscordMessageLike {
  author: { id: string; bot: boolean };
  channelId: string;
  content: string;
  channel: {
    send: (content: string) => Promise<unknown>;
    sendTyping: () => Promise<unknown>;
  };
}
