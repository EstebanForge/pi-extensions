# @estebanforge/pi-image-inline

Render images inline in the pi TUI (reads, browser screenshots) without spending model tokens. Strips pixels from tool results before they reach the model.

## Why

The native `agent_browser` tool returns screenshots as image content blocks. The pixels enter the model context even when the image is only for your eyes: roughly a 23k-token cache-miss re-bill per screenshot. What you actually want is images for your eyes at zero model cost, and normal vision when the agent explicitly asks for it. No existing package does both; the two that exist own disjoint halves (one renders but never redacts, one redacts nothing pre-send).

## Behavior

| Flow | Without this package | With this package |
|---|---|---|
| `read` a PNG | renders, pixels billed | unchanged |
| `agent_browser` capture | renders, pixels billed | rendered free; model sees a text placeholder |
| shell `agent-browser screenshot <path>` | nothing (or a preview extension) | rendered free, TUI-only |
| shell capture, then `read` | renders, pixels billed | unchanged |

Details:

- Capture tools (`agent_browser`, `chrome_devtools_take_screenshot`, any `*_take_screenshot`): every image block in the result is replaced with a text placeholder naming the saved file and its pixel size. The placeholder tells the model it can call `read` on the path if it needs the pixels agentically. `structuredContent` is always passed back through, so pi keeps the tool's structured data.
- The stripped image is rendered transcript-inline via a kitty-graphics entry renderer. Inside tmux (and herdr panes) it uses Unicode placeholders with DCS passthrough; outside tmux it uses pi-tui's Image component with a text fallback. Entries persist with the session and are never sent to the model.
- `read` results are exempt and always pass through untouched. The model asked for vision explicitly; stripping it would cause re-read loops.
- Nested tool calls are still redacted but never draw transcript entries.
- Shell captures (`agent-browser screenshot <path>` through the exec tool) never carry pixels, so they are rendered TUI-only with an mtime gate: only files the command actually produced are inlined.

## Install

```sh
pi install @estebanforge/pi-image-inline
```

Uninstall `pi-image-preview` and `jnsahaj/pi-agent-browser-screenshot` in the same step: the preview re-injects image blocks into stripped results, which defeats the redaction.

## Config

Lockdown mode for zero-pixel runs:

```json
{ "stripRead": true }
```

in `~/.pi/agent/pi-image-inline.json`, or pass `--image-inline-strip-read` for one session. Default false.

## Terminal requirements

The tmux path needs tmux 3.3+ with `set -g allow-passthrough on` and a terminal that implements kitty Unicode placeholders (kitty >= 0.28, Ghostty). Without that, entries fall back to a text line. `PI_IMAGE_PROTOCOL=kitty` must be set for the graphics path (dotfiles export it over ssh).

## Scope

Image blocks that name no file on disk are cached under the OS temp dir so the renderer has a path after resume; temp dirs can be cleaned by the OS, in which case the entry shows a placeholder line. Custom entries are omitted from HTML exports; the text placeholders survive there.
