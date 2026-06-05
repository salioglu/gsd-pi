// Project/App: gsd-pi
// File Purpose: Optional built-in planner handoff after milestone planning.

import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { gsdRoot } from "./paths.js";

export const PLANNER_HANDOFF_RULE_NAME = "planning review handoff -> /gsd planner";
export const GSD_PLANNER_VIEW = "planner";
export const LEGACY_GSD_PLANNER_COMMAND = "gsd-planner";
export const GSD_WEB_INITIAL_PATH_FLAG = "--web-initial-path";

export interface GsdLauncherSpec {
  command: string;
  baseArgs: string[];
}

export interface GsdPlannerLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  initialPath: string;
  milestoneId: string | null;
}

export interface GsdPlannerLaunchInput {
  basePath: string;
  milestoneId?: string | null;
}

export type GsdPlannerLaunchResult =
  | { status: "launched"; plan: GsdPlannerLaunchPlan }
  | { status: "failed"; plan: GsdPlannerLaunchPlan; error: Error };

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface GsdPlannerLaunchDeps {
  launcher?: GsdLauncherSpec;
  spawn?: SpawnLike;
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

function resolveCurrentGsdLauncher(): GsdLauncherSpec {
  const entrypoint = process.argv[1];
  if (entrypoint) {
    return {
      command: process.execPath,
      baseArgs: [entrypoint],
    };
  }
  return {
    command: "gsd",
    baseArgs: [],
  };
}

export function buildGsdPlannerLaunchPlan(
  input: GsdPlannerLaunchInput,
  launcher: GsdLauncherSpec = resolveCurrentGsdLauncher(),
): GsdPlannerLaunchPlan {
  const milestoneId = input.milestoneId?.trim();
  const initialPath = buildGsdPlannerInitialPath(milestoneId);
  return {
    command: launcher.command,
    args: [...launcher.baseArgs, "--web", input.basePath, GSD_WEB_INITIAL_PATH_FLAG, initialPath],
    cwd: input.basePath,
    initialPath,
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
  const plan = buildGsdPlannerLaunchPlan(input, deps.launcher);
  const spawn = deps.spawn ?? spawnChild;

  let child: ChildProcess;
  try {
    child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (err) {
    return {
      status: "failed",
      plan,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: GsdPlannerLaunchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.once("error", (err) => {
      settle({
        status: "failed",
        plan,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    });
    child.once("spawn", () => {
      child.unref();
      settle({ status: "launched", plan });
    });
  });
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
    `Open the built-in web app manually: ${["gsd", "--web", plan.cwd, GSD_WEB_INITIAL_PATH_FLAG, plan.initialPath].map(quoteArg).join(" ")}`,
    "Continue without planner edits: /gsd auto",
  ].join("\n");
}
