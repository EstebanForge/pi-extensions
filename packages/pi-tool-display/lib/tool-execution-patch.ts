import {
  type ExtensionAPI,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { onReloadShutdown } from "./extension-lifecycle.js";
import {
  type RenderTheme,
  formatMcpCallLine,
  renderMcpResult,
} from "./tool-overrides.js";
import { getTextField, isMcpToolCandidate, toRecord } from "./tool-metadata.js";
import type { ToolDisplayConfig } from "./types.js";

// Render MCP tools at render time by patching ToolExecutionComponent's renderer
// accessors. Pi's per-extension registerTool and renderer-less getAllTools()
// projections make the registration-time decoration paths miss MCP tools; this
// patch decides per component instance, reading the live toolDefinition.

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
  toolDefinition?: ToolDefLike;
  builtInToolDefinition?: unknown;
}

function getToolExecutionPrototype(): PatchableToolExecutionPrototype {
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

function patchToolExecutionMcpRender(
  getConfig: () => ToolDisplayConfig,
): void {
  const proto = getToolExecutionPrototype();
  if (
    typeof proto.getCallRenderer !== "function"
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
    return originalGetCallRenderer?.call(this);
  };

  proto.getResultRenderer = function (this: PatchableToolExecutionPrototype): ResultRenderer | undefined {
    if (isMcpRenderCandidate(this)) {
      // The component hands us its own result shape; ToolRenderInput is the
      // structural reader, so the cast is a boundary marker, not a loophole.
      return (result, options, theme) =>
        renderMcpResult(result as unknown as Parameters<typeof renderMcpResult>[0], options, getConfig(), theme);
    }
    return originalGetResultRenderer?.call(this);
  };

  proto.__piToolDisplayMcpPatchVersion = PATCH_VERSION;
  proto.__piToolDisplayMcpPatchOwner = PATCH_OWNER;
}

function restoreToolExecutionMcpRender(): void {
  const proto = getToolExecutionPrototype();
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
