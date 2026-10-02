import {
  type ExtensionAPI,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { onReloadShutdown } from "./extension-lifecycle.js";
import {
  type BuiltInDisplayRenderers,
  type RenderTheme,
  formatMcpCallLine,
  getBuiltInDisplayRenderers,
  renderMcpResult,
} from "./tool-overrides.js";
import { getTextField, isMcpToolCandidate, toRecord } from "./tool-metadata.js";
import type { ToolDisplayConfig } from "./types.js";

// Render MCP tools and stripped built-ins at render time by patching
// ToolExecutionComponent's renderer accessors. Pi's per-extension registerTool
// and renderer-less getAllTools() projections make the registration-time
// decoration paths miss MCP tools, and subagent children re-wrap tool
// definitions without their renderers (upstream issue 47). This patch decides
// per component instance, reading the live toolDefinition.

const PATCH_VERSION = 1;
const PATCH_OWNER = {};

type CallRenderer = (
  args: Record<string, unknown>,
  theme: RenderTheme,
  context?: unknown,
) => unknown;

type ResultRenderer = (
  result: { content?: unknown[]; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme,
  context?: unknown,
) => unknown;

interface ToolDefLike {
  name?: string;
  label?: string;
  description?: string;
  [key: string]: unknown;
}

interface PatchableToolExecutionPrototype {
  getCallRenderer: () => CallRenderer | undefined;
  getResultRenderer: () => ResultRenderer | undefined;
  __piToolDisplayOriginalGetCallRenderer?: () => CallRenderer | undefined;
  __piToolDisplayOriginalGetResultRenderer?: () => ResultRenderer | undefined;
  __piToolDisplayMcpPatchVersion?: number;
  __piToolDisplayMcpPatchOwner?: object;
  toolName?: string;
  toolDefinition?: ToolDefLike;
  builtInToolDefinition?: unknown;
}

function getToolExecutionPrototype(): PatchableToolExecutionPrototype | undefined {
  // Guarded access: an unexpected export shape must degrade to "no patch",
  // not crash extension load.
  if (!ToolExecutionComponent?.prototype) {
    return undefined;
  }
  return ToolExecutionComponent.prototype as unknown as PatchableToolExecutionPrototype;
}

function isMcpRenderCandidate(proto: PatchableToolExecutionPrototype): boolean {
  const def = proto.toolDefinition;
  if (!def) {
    return false;
  }
  // Older pi builds kept the built-in definition in a separate field; the
  // guard is inert on pi 1.0.0 (field removed) and the candidate test alone
  // decides there.
  if (proto.builtInToolDefinition) {
    return false;
  }
  return isMcpToolCandidate(def);
}

// Built-in fallback (issue 47): subagent children re-wrap tool definitions and
// drop the extension's renderers. When the live definition carries none and
// the tool name is one we decorate, rebuild the renderers at render time.
// Guards: a definition with either renderer keeps its rendering as-is (no
// hybrid splice), and a non-builtin sourceInfo means the name belongs to
// another extension's tool, which is never ours to decorate.
function builtInFallbackRenderers(
  proto: PatchableToolExecutionPrototype,
  getConfig: () => ToolDisplayConfig,
): BuiltInDisplayRenderers | undefined {
  const def = proto.toolDefinition;
  if (!def) {
    return undefined;
  }
  if (
    typeof def.renderCall === "function"
    || typeof def.renderResult === "function"
  ) {
    return undefined;
  }
  const source = getTextField(toRecord(def.sourceInfo), "source");
  if (source && source !== "builtin") {
    return undefined;
  }
  const toolName = (typeof proto.toolName === "string" && proto.toolName)
    || getTextField(def, "name");
  if (!toolName) {
    return undefined;
  }
  return getBuiltInDisplayRenderers(toolName, getConfig);
}

function patchToolExecutionMcpRender(
  getConfig: () => ToolDisplayConfig,
): void {
  const proto = getToolExecutionPrototype();
  if (
    !proto
    || typeof proto.getCallRenderer !== "function"
    || typeof proto.getResultRenderer !== "function"
  ) {
    return;
  }

  const previousCall = proto.__piToolDisplayOriginalGetCallRenderer;
  const previousResult = proto.__piToolDisplayOriginalGetResultRenderer;
  const hasPreviousPatch =
    typeof previousCall === "function" && previousCall !== proto.getCallRenderer;
  const isCurrentPatch = proto.__piToolDisplayMcpPatchOwner === PATCH_OWNER;

  if (hasPreviousPatch && !isCurrentPatch && typeof previousCall === "function" && typeof previousResult === "function") {
    proto.getCallRenderer = previousCall;
    proto.getResultRenderer = previousResult;
    delete proto.__piToolDisplayOriginalGetCallRenderer;
    delete proto.__piToolDisplayOriginalGetResultRenderer;
    delete proto.__piToolDisplayMcpPatchVersion;
    delete proto.__piToolDisplayMcpPatchOwner;
  }

  if (
    proto.__piToolDisplayMcpPatchVersion === PATCH_VERSION
    && proto.__piToolDisplayMcpPatchOwner === PATCH_OWNER
    && typeof proto.__piToolDisplayOriginalGetCallRenderer === "function"
  ) {
    return;
  }

  if (!proto.__piToolDisplayOriginalGetCallRenderer) {
    proto.__piToolDisplayOriginalGetCallRenderer = proto.getCallRenderer;
  }
  if (!proto.__piToolDisplayOriginalGetResultRenderer) {
    proto.__piToolDisplayOriginalGetResultRenderer = proto.getResultRenderer;
  }

  const originalGetCallRenderer = proto.__piToolDisplayOriginalGetCallRenderer;
  const originalGetResultRenderer = proto.__piToolDisplayOriginalGetResultRenderer;

  proto.getCallRenderer = function (this: PatchableToolExecutionPrototype): CallRenderer | undefined {
    if (isMcpRenderCandidate(this)) {
      const def = this.toolDefinition;
      const toolName = (def && getTextField(def, "name")) ?? "mcp";
      const toolLabel =
        (def && getTextField(def, "label"))
        ?? (toolName === "mcp" ? "MCP Proxy" : `MCP ${toolName}`);
      return (args, theme) => formatMcpCallLine(toolName, toolLabel, toRecord(args), theme);
    }
    const builtIn = builtInFallbackRenderers(this, getConfig);
    if (builtIn) {
      return builtIn.renderCall as CallRenderer;
    }
    return originalGetCallRenderer?.call(this);
  };

  proto.getResultRenderer = function (this: PatchableToolExecutionPrototype): ResultRenderer | undefined {
    if (isMcpRenderCandidate(this)) {
      // The component hands us its own result shape; ToolRenderInput is the
      // structural reader, so the cast is a boundary marker, not a loophole.
      return (result, options, theme) =>
        renderMcpResult(result as unknown as Parameters<typeof renderMcpResult>[0], options, getConfig(), theme);
    }
    const builtIn = builtInFallbackRenderers(this, getConfig);
    if (builtIn) {
      return builtIn.renderResult as ResultRenderer;
    }
    return originalGetResultRenderer?.call(this);
  };

  proto.__piToolDisplayMcpPatchVersion = PATCH_VERSION;
  proto.__piToolDisplayMcpPatchOwner = PATCH_OWNER;
}

function restoreToolExecutionMcpRender(): void {
  const proto = getToolExecutionPrototype();
  if (!proto) {
    return;
  }
  const originalCall = proto.__piToolDisplayOriginalGetCallRenderer;
  const originalResult = proto.__piToolDisplayOriginalGetResultRenderer;
  if (typeof originalCall === "function") {
    proto.getCallRenderer = originalCall;
  }
  if (typeof originalResult === "function") {
    proto.getResultRenderer = originalResult;
  }
  delete proto.__piToolDisplayOriginalGetCallRenderer;
  delete proto.__piToolDisplayOriginalGetResultRenderer;
  delete proto.__piToolDisplayMcpPatchVersion;
  delete proto.__piToolDisplayMcpPatchOwner;
}

export default function registerToolExecutionMcpPatch(
  pi: ExtensionAPI,
  getConfig: () => ToolDisplayConfig,
): void {
  patchToolExecutionMcpRender(getConfig);

  onReloadShutdown(pi, () => {
    restoreToolExecutionMcpRender();
  });

  pi.on("before_agent_start", async () => {
    patchToolExecutionMcpRender(getConfig);
  });

  pi.on("session_start", async () => {
    patchToolExecutionMcpRender(getConfig);
  });
}
