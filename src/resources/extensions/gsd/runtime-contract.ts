import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";

import type { GSDPreferences } from "./preferences-types.js";
import { resolveGsdPathContract } from "./paths.js";

const DEFAULT_CONTRACT_PATH = join("script", "local-runtime");
const DEFAULT_ENTRY_NAMES = ["runtime.mjs", "runtime.js", "runtime.ts", "runtime.sh"];

export interface ResolvedRuntimeContract {
  directory: string;
  agentInstructionsPath?: string;
  readmePath?: string;
  entryPath?: string;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !win32.isAbsolute(rel));
}

function resolveContractFile(contractDir: string, name: string): string | undefined {
  const candidate = join(contractDir, name);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined;

  const resolved = realpathSync.native(candidate);
  return isWithin(contractDir, resolved) ? resolved : undefined;
}

function discoverRuntimeContract(
  basePath: string,
  preferences?: GSDPreferences,
): ResolvedRuntimeContract | null {
  const projectRoot = realpathSync.native(resolveGsdPathContract(basePath).workRoot);
  const configured = preferences?.runtime?.contract;
  const contractPath = configured?.path ?? DEFAULT_CONTRACT_PATH;
  if (isAbsolute(contractPath) || win32.isAbsolute(contractPath)) return null;

  const candidateDir = resolve(projectRoot, contractPath);
  if (!isWithin(projectRoot, candidateDir) || !existsSync(candidateDir) || !statSync(candidateDir).isDirectory()) {
    return null;
  }

  const contractDir = realpathSync.native(candidateDir);
  if (!isWithin(projectRoot, contractDir)) return null;

  const agentInstructionsPath = resolveContractFile(contractDir, "AGENT.md");
  const readmePath = resolveContractFile(contractDir, "README.md");
  const entryNames = configured?.entry ? [configured.entry] : DEFAULT_ENTRY_NAMES;
  const entryPath = entryNames
    .map((name) => resolveContractFile(contractDir, name))
    .find((path) => path !== undefined);

  if (!agentInstructionsPath && !readmePath && !entryPath) return null;
  return {
    directory: contractDir,
    ...(agentInstructionsPath ? { agentInstructionsPath } : {}),
    ...(readmePath ? { readmePath } : {}),
    ...(entryPath ? { entryPath } : {}),
  };
}

export function resolveRuntimeContract(
  basePath: string,
  preferences?: GSDPreferences,
): ResolvedRuntimeContract | null {
  try {
    return discoverRuntimeContract(basePath, preferences);
  } catch {
    return null;
  }
}

export function renderRuntimeContractForSystemPrompt(
  basePath: string,
  preferences?: GSDPreferences,
): string {
  const contract = resolveRuntimeContract(basePath, preferences);
  if (!contract) return "";

  const lines = [
    "## Project-local runtime contract",
    "",
    "Before starting, restarting, seeding, or tearing down any business project in this repository, read and follow this contract.",
  ];
  if (contract.agentInstructionsPath) lines.push(`- Agent rules: ${JSON.stringify(contract.agentInstructionsPath)}`);
  if (contract.readmePath) lines.push(`- Runtime documentation: ${JSON.stringify(contract.readmePath)}`);
  if (contract.entryPath) lines.push(`- Canonical entry point: ${JSON.stringify(contract.entryPath)}`);
  lines.push(
    "- Do not start business projects directly with npm, pnpm, or docker compose commands unless the runtime contract explicitly delegates to them.",
  );
  return lines.join("\n");
}
