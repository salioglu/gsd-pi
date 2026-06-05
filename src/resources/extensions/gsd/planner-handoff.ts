// Project/App: gsd-pi
// File Purpose: Optional built-in planner handoff after milestone planning.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentDir as defaultAgentDir, sessionsDir as defaultSessionsDir } from "../../../app-paths.js";
import { getProjectSessionsDir } from "../../../project-sessions.js";
import { launchWebMode, type WebModeLaunchStatus } from "../../../web-mode.js";
import { gsdRoot } from "./paths.js";

export const PLANNER_HANDOFF_RULE_NAME = "planning review handoff -> /gsd planner";
export const GSD_PLANNER_VIEW = "planner";
export const LEGACY_GSD_PLANNER_COMMAND = "gsd-planner";

export interface GsdPlannerLaunchPlan {
  cwd: string;
  initialPath: string;
  milestoneId: string | null;
}

export interface GsdPlannerLaunchInput {
  basePath: string;
  milestoneId?: string | null;
}

export type GsdPlannerLaunchResult =
  | { status: "launched"; plan: GsdPlannerLaunchPlan; webStatus: WebModeLaunchStatus }
  | { status: "failed"; plan: GsdPlannerLaunchPlan; webStatus: WebModeLaunchStatus; error: Error };

export interface GsdPlannerLaunchDeps {
  launchWebMode?: typeof launchWebMode;
  agentDir?: string;
  sessionsDir?: string;
}

function handoffDir(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "planner-handoffs");
}

function safeMilestoneFileSegment(milestoneId: string): string {
  return milestoneId.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}

function handoffMarkerPath(basePath: string, milestoneId: string): string {
  return join(handoffDir(basePath), `${safeMilestoneFileSegment(milestoneId)}.json`);
}

export function hasPlannerHandoffBeenOffered(basePath: string, milestoneId: string): boolean {
  return existsSync(handoffMarkerPath(basePath, milestoneId));
}

export function markPlannerHandoffOffered(
  basePath: string,
  milestoneId: string,
  source: "auto" | "command" = "auto",
): void {
  mkdirSync(handoffDir(basePath), { recursive: true });
  writeFileSync(
    handoffMarkerPath(basePath, milestoneId),
    JSON.stringify({
      milestoneId,
      source,
      offeredAt: new Date().toISOString(),
    }, null, 2) + "\n",
    "utf-8",
  );
}

export function buildGsdPlannerInitialPath(milestoneId?: string | null): string {
  const params = new URLSearchParams({ view: GSD_PLANNER_VIEW });
  const normalizedMilestoneId = milestoneId?.trim();
  if (normalizedMilestoneId) params.set("milestone", normalizedMilestoneId);
  return `/?${params.toString()}`;
}

export function buildGsdPlannerLaunchPlan(input: GsdPlannerLaunchInput): GsdPlannerLaunchPlan {
  const milestoneId = input.milestoneId?.trim();
  return {
    cwd: input.basePath,
    initialPath: buildGsdPlannerInitialPath(milestoneId),
    milestoneId: milestoneId || null,
  };
}

function quoteArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function formatGsdPlannerLaunchTarget(plan: GsdPlannerLaunchPlan): string {
  return `GSD Planner route: ${plan.initialPath}`;
}

export async function launchGsdPlanner(
  input: GsdPlannerLaunchInput,
  deps: GsdPlannerLaunchDeps = {},
): Promise<GsdPlannerLaunchResult> {
  const plan = buildGsdPlannerLaunchPlan(input);
  const webStatus = await (deps.launchWebMode ?? launchWebMode)({
    cwd: plan.cwd,
    projectSessionsDir: getProjectSessionsDir(plan.cwd, deps.sessionsDir ?? defaultSessionsDir),
    agentDir: deps.agentDir ?? defaultAgentDir,
    initialPath: plan.initialPath,
  });

  if (!webStatus.ok) {
    return {
      status: "failed",
      plan,
      webStatus,
      error: new Error(webStatus.failureReason),
    };
  }

  return { status: "launched", plan, webStatus };
}

export function formatPlannerHandoffPauseReason(milestoneId: string): string {
  return [
    `Milestone ${milestoneId} is planned. Review or customize the plan before implementation if needed.`,
    "Run /gsd planner to open the built-in Planner, or run /gsd auto to continue without planner changes.",
  ].join(" ");
}

export function formatPlannerLaunchUnavailable(plan: GsdPlannerLaunchPlan, error: Error): string {
  return [
    `Could not launch GSD Planner: ${error.message}`,
    `Open the built-in web app manually: ${["gsd", "--web", plan.cwd].map(quoteArg).join(" ")}`,
    "Continue without planner edits: /gsd auto",
  ].join("\n");
}
