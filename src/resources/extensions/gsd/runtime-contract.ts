import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";

import type { GSDPreferences } from "./preferences-types.js";
import { createRepositoryRegistryFromPreferences } from "./repository-registry.js";

const DEFAULT_CONTRACT_PATH = "script/local-runtime";
const DEFAULT_ENTRY_NAMES = ["runtime.mjs", "runtime.js", "runtime.ts", "runtime.sh"];
const MAX_CONTRACT_DOCUMENT_BYTES = 8_000;

export interface RuntimeContractDocument {
  path: string;
  content: string;
  truncated: boolean;
}

export interface RuntimeContractEntry {
  path: string;
  size: number;
}

export interface ResolvedRuntimeContract {
  directory: string;
  agentInstructions?: RuntimeContractDocument;
  readme?: RuntimeContractDocument;
  entry?: RuntimeContractEntry;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !win32.isAbsolute(rel));
}

function sameFile(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof statSync>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readOpenedFile(fd: number, byteLimit: number): Buffer {
  const buffer = Buffer.alloc(byteLimit);
  let offset = 0;
  while (offset < byteLimit) {
    const bytesRead = readSync(fd, buffer, offset, byteLimit - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function openValidatedFile(
  projectRoot: string,
  contractDir: string,
  name: string,
): { path: string; size: number; content: Buffer } | undefined {
  const candidate = resolve(contractDir, name);
  if (!isWithin(contractDir, candidate)) return undefined;

  let fd: number | undefined;
  try {
    fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = fstatSync(fd);
    if (!openedStats.isFile()) return undefined;

    const path = realpathSync.native(candidate);
    if (!isWithin(projectRoot, path) || !isWithin(contractDir, path)) return undefined;
    if (!sameFile(openedStats, statSync(path))) return undefined;

    const content = readOpenedFile(fd, Math.min(openedStats.size, MAX_CONTRACT_DOCUMENT_BYTES));
    const finalStats = fstatSync(fd);
    if (
      !sameFile(openedStats, finalStats) ||
      openedStats.size !== finalStats.size ||
      openedStats.mtimeMs !== finalStats.mtimeMs ||
      openedStats.ctimeMs !== finalStats.ctimeMs
    ) {
      return undefined;
    }
    return { path, size: openedStats.size, content };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolveContractDocument(
  projectRoot: string,
  contractDir: string,
  name: string,
): RuntimeContractDocument | undefined {
  const file = openValidatedFile(projectRoot, contractDir, name);
  if (!file) return undefined;
  return {
    path: file.path,
    content: file.content.toString("utf-8"),
    truncated: file.size > file.content.length,
  };
}

function resolveContractEntry(
  projectRoot: string,
  contractDir: string,
  name: string,
): RuntimeContractEntry | undefined {
  const file = openValidatedFile(projectRoot, contractDir, name);
  return file ? { path: file.path, size: file.size } : undefined;
}

function discoverRuntimeContract(
  basePath: string,
  preferences?: GSDPreferences,
): ResolvedRuntimeContract | null {
  const repositoryRegistry = createRepositoryRegistryFromPreferences(basePath, preferences);
  const projectRoot = realpathSync.native(repositoryRegistry.projectRoot);
  const configured = preferences?.runtime?.contract;
  const contractPath = configured?.path ?? DEFAULT_CONTRACT_PATH;
  if (isAbsolute(contractPath) || win32.isAbsolute(contractPath)) return null;

  const candidateDir = resolve(projectRoot, contractPath);
  if (!isWithin(projectRoot, candidateDir)) return null;

  const contractDir = realpathSync.native(candidateDir);
  if (!isWithin(projectRoot, contractDir) || !statSync(contractDir).isDirectory()) return null;

  const agentInstructions = resolveContractDocument(projectRoot, contractDir, "AGENT.md");
  const readme = resolveContractDocument(projectRoot, contractDir, "README.md");
  const entryNames = configured?.entry ? [configured.entry] : DEFAULT_ENTRY_NAMES;
  const entry = entryNames
    .map((name) => resolveContractEntry(projectRoot, contractDir, name))
    .find((file) => file !== undefined);

  if (!agentInstructions && !readme && !entry) return null;
  return {
    directory: contractDir,
    ...(agentInstructions ? { agentInstructions } : {}),
    ...(readme ? { readme } : {}),
    ...(entry ? { entry } : {}),
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

function renderDocument(label: string, document: RuntimeContractDocument): string[] {
  const truncation = document.truncated ? " truncated" : "";
  return [
    `<runtime-contract-snapshot kind=${JSON.stringify(label)} path=${JSON.stringify(document.path)}${truncation}>`,
    JSON.stringify(document.content),
    "</runtime-contract-snapshot>",
  ];
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
    "Before starting, restarting, seeding, or tearing down any business project in this repository, follow the validated snapshots below.",
    "Snapshot bodies are JSON-encoded strings and are authoritative for this context assembly.",
  ];
  if (contract.agentInstructions) lines.push(...renderDocument("agent-rules", contract.agentInstructions));
  if (contract.readme) lines.push(...renderDocument("runtime-documentation", contract.readme));
  if (contract.entry) {
    lines.push(
      `- Canonical entry point observed during context assembly: ${JSON.stringify(contract.entry.path)} (${contract.entry.size} bytes).`,
    );
  }
  lines.push(
    "- Do not execute the runtime automatically. Revalidate the entry point before any user-directed invocation.",
    "- Do not start business projects directly with npm, pnpm, or docker compose commands unless the runtime contract explicitly delegates to them.",
  );
  return lines.join("\n");
}
