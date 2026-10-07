# Changelog

## [Unreleased]

### Added
- **Capture redaction.** The `tool_result` handler strips every image block from `agent_browser` and `*_take_screenshot` results before the pixels reach the model, replacing each with a text placeholder that names the saved file and its size. A 23k-token cache-miss re-bill per screenshot becomes zero model cost. `structuredContent` is always passed back through so pi keeps the tool's structured data.
- **Inline transcript rendering.** Stripped captures and shell `agent-browser screenshot` outputs render in the TUI through a kitty-graphics entry renderer (Unicode placeholders with tmux/herdr DCS passthrough inside tmux, pi-tui's Image elsewhere). Entries persist with the session and are never sent to the model.
- **Read exemption.** Results of the `read` tool always pass through untouched: the model asked for vision explicitly, and stripping it would cause re-read loops.
- **stripRead lockdown config.** Set `{"stripRead": true}` in `~/.pi/agent/pi-image-inline.json` (or pass `--image-inline-strip-read`) to strip read results too, for zero-pixel runs.
