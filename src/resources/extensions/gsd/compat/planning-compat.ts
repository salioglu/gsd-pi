// Project/App: gsd-pi
// File Purpose: `.planning/` compat helpers — layout capture and projection sha
// recording. Parallel to the .gsd/ write-time flush in markdown-renderer.ts.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
  type PlanningLayout,
} from "./compat-marker.js";

export interface PlanningProjectionWrite {
  relPath: string;
  entities: string[];
  passthrough?: boolean;
}

function isPlanningPassthroughRelPath(relPath: string): boolean {
  if (relPath.startsWith("codebase/") || relPath.startsWith("research/")) return true;
  if (relPath === "config.json") return true;
  const name = relPath.split("/").pop() ?? relPath;
  if (name === "PATTERNS.md" || name === "REVIEWS.md") return true;
  if (name.endsWith("-DISCUSSION-LOG.md")) return true;
  if (name.endsWith("-RESEARCH.md") && !name.endsWith("-PLAN.md")) return true;
  return false;
}

function walkPlanningRelPaths(planningDir: string, prefix = ""): string[] {
  const paths: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(planningDir, prefix), { withFileTypes: true });
  } catch {
    return paths;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "workstreams") continue;
      paths.push(...walkPlanningRelPaths(planningDir, rel));
    } else {
      paths.push(rel);
    }
  }
  return paths;
}

/**
 * Record freshly written `.planning/` projection files in the compat marker.
 */
export function applyPlanningProjectionWrites(
  basePath: string,
  writes: PlanningProjectionWrite[],
): void {
  if (writes.length === 0) return;
  const marker = readCompatMarker(basePath);
  if (!marker.planning) {
    marker.planning = { active: true, layout: null, projections: {}, passthrough: {} };
  }
  marker.planning.active = true;
  for (const write of writes) {
    const abs = join(basePath, ".planning", write.relPath);
    if (!existsSync(abs)) continue;
    const entry = {
      sha: computeProjectionSha(readFileSync(abs, "utf-8")),
      entities: write.entities,
    };
    const map = write.passthrough ? marker.planning.passthrough : marker.planning.projections;
    map[write.relPath] = entry;
  }
  marker.lastWriter = "gsd-pi";
  marker.lastProjectedAt = new Date().toISOString();
  writeCompatMarker(basePath, marker);
}

function seedPlanningShasFromDisk(basePath: string): void {
  const planningDir = join(basePath, ".planning");
  const marker = readCompatMarker(basePath);
  if (!marker.planning) {
    marker.planning = { active: true, layout: null, projections: {}, passthrough: {} };
  }
  for (const relPath of walkPlanningRelPaths(planningDir)) {
    const abs = join(planningDir, relPath);
    const entry = {
      sha: computeProjectionSha(readFileSync(abs, "utf-8")),
      entities: [] as string[],
    };
    const map = isPlanningPassthroughRelPath(relPath)
      ? marker.planning.passthrough
      : marker.planning.projections;
    map[relPath] = entry;
  }
  marker.lastWriter = "gsd-pi";
  marker.lastProjectedAt = new Date().toISOString();
  writeCompatMarker(basePath, marker);
}

/**
 * Capture-on-first-read: infer `.planning/` layout from disk and seed marker
 * shas so external-edit drift detection has a baseline.
 */
export async function capturePlanningCompatIfNeeded(basePath: string): Promise<void> {
  const planningDir = join(basePath, ".planning");
  if (!existsSync(planningDir)) return;

  const marker = readCompatMarker(basePath);
  const mapsEmpty =
    Object.keys(marker.planning?.projections ?? {}).length === 0 &&
    Object.keys(marker.planning?.passthrough ?? {}).length === 0;

  if (marker.planning?.active && marker.planning.layout) {
    if (!mapsEmpty) return;
    seedPlanningShasFromDisk(basePath);
    return;
  }

  const { parsePlanningDirectory } = await import("../migrate/parser.js");
  const { detectPlanningLayout } = await import("../migrate/layout-detect.js");
  const parsed = await parsePlanningDirectory(planningDir);
  const layout: PlanningLayout | null = detectPlanningLayout(parsed);
  if (!layout) return;

  if (!marker.planning) {
    marker.planning = { active: false, layout: null, projections: {}, passthrough: {} };
  }
  marker.planning.active = true;
  marker.planning.layout = layout;
  writeCompatMarker(basePath, marker);
  seedPlanningShasFromDisk(basePath);
}
