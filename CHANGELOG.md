# Changelog

## 1.0.0 (2026-08-24)

First release. The footer now tells you which machine you're on.

Shows `💻 <hostname>` as the first item of the footer status line (bottom left), so you stop typing commands on the wrong box.

### Added

- Footer status item set on `session_start`, keyed `0-hostname`. The numeric prefix is load-bearing: Pi sorts extension statuses alphabetically by key, so digits pin the hostname to the first slot, ahead of letter keys like `agentmemory` and `codegraph`.
- Domain stripping: `os.hostname()` reduced to its first label (`mini.local` becomes `mini`), trailing dot dropped.
