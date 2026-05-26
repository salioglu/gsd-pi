export type SessionStateChangeReason =
  | "new_session"
  | "switch_session"
  | "fork"
  | "reload"
  | "set_session_name"
  | "set_model"
  | "set_thinking_level";

export type AgentSessionEvent =
  | { type: "agent_end"; [key: string]: unknown }
  | { type: "turn_end"; [key: string]: unknown }
  | { type: "auto_retry_start"; [key: string]: unknown }
  | { type: "auto_retry_end"; [key: string]: unknown }
  | { type: "auto_compaction_start"; [key: string]: unknown }
  | { type: "auto_compaction_end"; [key: string]: unknown }
  | { type: "session_state_changed"; reason: SessionStateChangeReason; [key: string]: unknown }
  | { type: string; [key: string]: unknown };
