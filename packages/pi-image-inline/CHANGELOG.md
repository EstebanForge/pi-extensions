# Changelog

## [Unreleased]

### Added
- **Capture redaction.** The `tool_result` handler strips every image block from `agent_browser` and `*_take_screenshot` results before the pixels reach the model, replacing each with a text placeholder that names the saved file and its size. A 23k-token cache-miss re-bill per screenshot becomes zero model cost. `structuredContent` is always passed back through so pi keeps the tool's structured data.
- **Inline transcript rendering.** Stripped captures and shell `agent-browser screenshot` outputs render in the TUI through a kitty-graphics entry renderer (Unicode placeholders with tmux/herdr DCS passthrough inside tmux, pi-tui's Image elsewhere). Entries persist with the session and are never sent to the model.
- **Read exemption.** Results of the `read` tool always pass through untouched: the model asked for vision explicitly, and stripping it would cause re-read loops.
- **stripRead lockdown config.** Set `{"stripRead": true}` in `~/.pi/agent/pi-image-inline.json` (or pass `--image-inline-strip-read`) to strip read results too, for zero-pixel runs.

### Fixed
- **Multi-image captures.** Structured-image discovery now aggregates observations across batch arrays instead of stopping at the first hit, so every image in a multi-capture result resolves to its real file path; the `details` view is consulted only when `structuredContent` carries no images, preventing duplicate facts from misaligning per-block indexes.
- **Shell-tool capture detection.** The gate now keys off the command string for any shell tool (`bash`, `exec_command`, ...), not just `bash`; failed commands no longer leak their start-time entries.
- **Temp cache hardening.** The no-path fallback cache is now per-user (uid-suffixed dir, mode 0700) with exclusive 0600 file creation, closing symlink-plant and TOCTOU writes in shared temp dirs; a cache failure no longer renders a blank path in the placeholder.
- **Renderer input guards.** Transcript rendering refuses paths that are not regular image files under the 10MB cap before reading, cell-size math guards against 0px terminal cells, and the image cache refreshes on hit so hot entries are not evicted FIFO-style. Markdown-wrapped paths (`![alt](/path.png)`) are now recognized in shell-capture output.
