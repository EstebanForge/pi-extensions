# @estebanforge/pi-hostname

I work on several machines at once: local, a couple of remote boxes, the occasional VM that lives for a day. Every SSH window looks exactly the same, and I've typed more commands on the wrong machine than I care to admit.

So: this.

It puts the hostname of the box you're on in the Pi footer, bottom left, always the first item: `💻 mini`.

Problem solved.

## Install

```
pi install npm:@estebanforge/pi-hostname
```

That's it. No commands, no tools, no configuration.

## The one interesting detail

Pi collects the status items from every extension (the strings they set with `ctx.ui.setStatus()`) and renders them on a single footer line, sorted alphabetically by key.

Alphabetically. An extension keyed "hostname" would land after "agentmemory" and "codegraph", and I wanted it first. Always first.

The key is `0-hostname`. Digits sort before letters, so the hostname pins the leftmost slot. If you ever write an extension that must own that slot: steal the trick.

Two smaller decisions while we're here:

- The hostname comes from `os.hostname()` with the domain stripped (`mini.local` becomes `mini`), so the footer stays narrow.
- The emoji is 💻 (U+1F4BB) because it has default emoji presentation: it renders wide and colored in any terminal, with no variation-selector games. Some emoji need a variation selector to display right, and terminals miscount their width. This one just works.

## Develop

```
npm install
npm run typecheck
npm test
```
