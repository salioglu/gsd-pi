"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, CheckCircle2, FileText, RefreshCw, Save } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import { buildProjectPath } from "@/lib/project-url"
import {
  getLiveWorkspaceIndex,
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"
import type { WorkspaceMilestoneTarget } from "@/lib/workspace-types"

type PlannerDocKind = "roadmap" | "slice"

interface PlannerDocDescriptor {
  key: string
  kind: PlannerDocKind
  id: string
  title: string
  path: string
}

interface PlannerDocState {
  content: string
  savedContent: string
  loading: boolean
  saving: boolean
  error: string | null
}

function getRequestedMilestoneId(): string | null {
  if (typeof window === "undefined") return null
  const milestoneId = new URLSearchParams(window.location.search).get("milestone")?.trim()
  return milestoneId || null
}

function toGsdRelativePath(path: string | undefined): string | null {
  if (!path) return null
  const normalized = path.replace(/\\/g, "/")
  const gsdIndex = normalized.indexOf(".gsd/")
  if (gsdIndex >= 0) return normalized.slice(gsdIndex + ".gsd/".length)
  if (normalized.startsWith("/")) return null
  return normalized.replace(/^\.\//, "")
}

function fallbackRoadmapPath(milestoneId: string): string {
  return `milestones/${milestoneId}/${milestoneId}-ROADMAP.md`
}

function fallbackSlicePlanPath(milestoneId: string, sliceId: string): string {
  return `milestones/${milestoneId}/slices/${sliceId}/${sliceId}-PLAN.md`
}

function buildDocDescriptors(milestone: WorkspaceMilestoneTarget): PlannerDocDescriptor[] {
  const roadmapPath = toGsdRelativePath(milestone.roadmapPath) ?? fallbackRoadmapPath(milestone.id)
  const docs: PlannerDocDescriptor[] = [
    {
      key: `roadmap:${roadmapPath}`,
      kind: "roadmap",
      id: milestone.id,
      title: "Roadmap",
      path: roadmapPath,
    },
  ]

  for (const slice of milestone.slices) {
    const planPath = toGsdRelativePath(slice.planPath) ?? fallbackSlicePlanPath(milestone.id, slice.id)
    docs.push({
      key: `slice:${planPath}`,
      kind: "slice",
      id: slice.id,
      title: slice.title,
      path: planPath,
    })
  }

  return docs
}

function emptyDocState(): PlannerDocState {
  return {
    content: "",
    savedContent: "",
    loading: true,
    saving: false,
    error: null,
  }
}

async function loadPlannerFile(projectCwd: string, path: string): Promise<string> {
  const url = buildProjectPath(`/api/files?root=gsd&path=${encodeURIComponent(path)}`, projectCwd)
  const response = await authFetch(url, { cache: "no-store" })
  if (response.status === 404) return ""
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `Load failed (${response.status})`)
  }
  return typeof data.content === "string" ? data.content : ""
}

async function savePlannerFile(projectCwd: string, path: string, content: string): Promise<void> {
  const response = await authFetch(buildProjectPath("/api/files", projectCwd), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: "gsd", path, content }),
  })
  if (response.ok) return

  const data = await response.json().catch(() => ({}))
  throw new Error(typeof data.error === "string" ? data.error : `Save failed (${response.status})`)
}

function docTone(state: PlannerDocState | undefined): "error" | "dirty" | "saved" | "loading" | "saving" {
  if (!state || state.loading) return "loading"
  if (state.saving) return "saving"
  if (state.error) return "error"
  if (state.content !== state.savedContent) return "dirty"
  return "saved"
}

function docToneLabel(tone: ReturnType<typeof docTone>): string {
  if (tone === "error") return "Error"
  if (tone === "dirty") return "Unsaved"
  if (tone === "saving") return "Saving"
  if (tone === "loading") return "Loading"
  return "Saved"
}

export function PlannerView() {
  const workspace = useGSDWorkspaceState()
  const { refreshBoot } = useGSDWorkspaceActions()
  const liveWorkspace = getLiveWorkspaceIndex(workspace)
  const milestones = liveWorkspace?.milestones ?? []
  const activeMilestoneId = liveWorkspace?.active.milestoneId ?? null
  const projectCwd = workspace.boot?.project.cwd

  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string | null>(null)
  const [selectedDocKey, setSelectedDocKey] = useState<string | null>(null)
  const [docStates, setDocStates] = useState<Record<string, PlannerDocState>>({})

  useEffect(() => {
    if (selectedMilestoneId && milestones.some((milestone) => milestone.id === selectedMilestoneId)) return
    const requestedMilestoneId = getRequestedMilestoneId()
    const requested = milestones.find((milestone) => milestone.id === requestedMilestoneId)
    const active = milestones.find((milestone) => milestone.id === activeMilestoneId)
    const nextMilestone = requested ?? active ?? milestones[0] ?? null
    setSelectedMilestoneId(nextMilestone?.id ?? null)
  }, [activeMilestoneId, milestones, selectedMilestoneId])

  const selectedMilestone = useMemo(
    () => milestones.find((milestone) => milestone.id === selectedMilestoneId) ?? null,
    [milestones, selectedMilestoneId],
  )
  const docDescriptors = useMemo(
    () => (selectedMilestone ? buildDocDescriptors(selectedMilestone) : []),
    [selectedMilestone],
  )
  const docDescriptorKey = docDescriptors.map((doc) => doc.key).join("|")

  useEffect(() => {
    const firstDocKey = docDescriptors[0]?.key ?? null
    setSelectedDocKey((current) => {
      if (current && docDescriptors.some((doc) => doc.key === current)) return current
      return firstDocKey
    })
  }, [docDescriptorKey, docDescriptors])

  const loadDocuments = useCallback(async () => {
    if (!projectCwd || docDescriptors.length === 0) return

    setDocStates((current) => {
      const next = { ...current }
      for (const doc of docDescriptors) {
        next[doc.key] = { ...(next[doc.key] ?? emptyDocState()), loading: true, error: null }
      }
      return next
    })

    const loaded = await Promise.all(
      docDescriptors.map(async (doc) => {
        try {
          const content = await loadPlannerFile(projectCwd, doc.path)
          return {
            key: doc.key,
            state: {
              content,
              savedContent: content,
              loading: false,
              saving: false,
              error: null,
            },
          }
        } catch (error) {
          return {
            key: doc.key,
            state: {
              content: "",
              savedContent: "",
              loading: false,
              saving: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }),
    )

    setDocStates((current) => {
      const next = { ...current }
      for (const entry of loaded) {
        next[entry.key] = entry.state
      }
      return next
    })
  }, [docDescriptors, projectCwd])

  useEffect(() => {
    void loadDocuments()
  }, [loadDocuments])

  const selectedDoc = docDescriptors.find((doc) => doc.key === selectedDocKey) ?? null
  const selectedState = selectedDoc ? docStates[selectedDoc.key] : null
  const dirtyDocs = docDescriptors.filter((doc) => {
    const state = docStates[doc.key]
    return state && !state.loading && state.content !== state.savedContent
  })

  const updateSelectedContent = useCallback((content: string) => {
    if (!selectedDoc) return
    setDocStates((current) => ({
      ...current,
      [selectedDoc.key]: {
        ...(current[selectedDoc.key] ?? emptyDocState()),
        content,
        loading: false,
        error: null,
      },
    }))
  }, [selectedDoc])

  const saveDocument = useCallback(async (doc: PlannerDocDescriptor) => {
    if (!projectCwd) return
    const state = docStates[doc.key]
    if (!state || state.loading) return

    setDocStates((current) => ({
      ...current,
      [doc.key]: { ...(current[doc.key] ?? state), saving: true, error: null },
    }))

    try {
      await savePlannerFile(projectCwd, doc.path, state.content)
      setDocStates((current) => ({
        ...current,
        [doc.key]: {
          ...(current[doc.key] ?? state),
          savedContent: state.content,
          saving: false,
          error: null,
        },
      }))
      toast.success(`Saved ${doc.id}`)
      await refreshBoot({ soft: true })
    } catch (error) {
      setDocStates((current) => ({
        ...current,
        [doc.key]: {
          ...(current[doc.key] ?? state),
          saving: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }))
    }
  }, [docStates, projectCwd, refreshBoot])

  const saveDirtyDocuments = useCallback(async () => {
    for (const doc of dirtyDocs) {
      await saveDocument(doc)
    }
  }, [dirtyDocs, saveDocument])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Planner</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{selectedMilestone?.id ?? "No milestone"}</span>
            {selectedMilestone?.title && <span className="truncate">{selectedMilestone.title}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selectedMilestoneId ?? ""}
            onValueChange={(value) => setSelectedMilestoneId(value)}
            disabled={milestones.length === 0}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Milestone" />
            </SelectTrigger>
            <SelectContent>
              {milestones.map((milestone) => (
                <SelectItem key={milestone.id} value={milestone.id}>
                  {milestone.id} - {milestone.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => void loadDocuments()} disabled={!projectCwd}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => void saveDirtyDocuments()} disabled={dirtyDocs.length === 0}>
            <Save className="h-4 w-4" />
            Save All
          </Button>
        </div>
      </div>

      {milestones.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No planned milestones found.
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-b border-border bg-sidebar/40 p-3 lg:border-b-0 lg:border-r">
            <div className="space-y-2">
              {docDescriptors.map((doc) => {
                const state = docStates[doc.key]
                const tone = docTone(state)
                return (
                  <button
                    key={doc.key}
                    type="button"
                    onClick={() => setSelectedDocKey(doc.key)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-md border border-transparent px-3 py-2 text-left transition-colors",
                      selectedDocKey === doc.key
                        ? "border-border bg-background shadow-xs"
                        : "hover:bg-background/70",
                    )}
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{doc.title}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {doc.path}
                      </span>
                    </span>
                    <Badge variant="outline" className="shrink-0 rounded text-[10px]">
                      {docToneLabel(tone)}
                    </Badge>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden">
            {selectedDoc && selectedState ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-sm font-semibold">{selectedDoc.title}</h2>
                      <Badge variant="outline" className="rounded text-[10px]">
                        {selectedDoc.kind === "roadmap" ? "Roadmap" : "Slice Plan"}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      .gsd/{selectedDoc.path}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => void saveDocument(selectedDoc)}
                    disabled={
                      selectedState.loading ||
                      selectedState.saving ||
                      selectedState.content === selectedState.savedContent
                    }
                  >
                    <Save className="h-4 w-4" />
                    Save
                  </Button>
                </div>

                {selectedState.error && (
                  <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 truncate">{selectedState.error}</span>
                  </div>
                )}

                <div className="min-h-0 flex-1 p-4">
                  <Textarea
                    value={selectedState.content}
                    onChange={(event) => updateSelectedContent(event.target.value)}
                    disabled={selectedState.loading || selectedState.saving}
                    spellCheck={false}
                    className="h-full min-h-[360px] resize-none font-mono text-sm leading-6"
                    placeholder={selectedState.loading ? "Loading..." : "No content"}
                  />
                </div>

                <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
                  <span>{selectedState.content.length.toLocaleString()} chars</span>
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {docToneLabel(docTone(selectedState))}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Select a plan document.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
