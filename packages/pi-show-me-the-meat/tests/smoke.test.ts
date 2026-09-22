import { describe, it, expect } from "vitest";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";

import { numberDiff, compilePlan, manifestLine } from "../extensions/compiler.js";
import { abridgeViaSubagent } from "../extensions/subagent.js";

// A diff with real signal (the errors.As retry branch) buried under churn:
// an import shuffle, whitespace-only edits, and a doc-comment tweak. A good
// abridge keeps the error branch and elides the rest.
const SAMPLE_DIFF = `diff --git a/uploader.go b/uploader.go
index 1111111..2222222 100644
--- a/uploader.go
+++ b/uploader.go
@@ -1,14 +1,18 @@
 package uploader
 
-import "context"
-import "fmt"
-import "io"
-import "os"
+import (
+\t"context"
+\t"errors"
+\t"fmt"
+\t"io"
+\t"os"
+)
 
 // Uploader sends blobs to the object store. It retries on transient
-// failures using a fixed backoff.
+// failures using an exponential backoff.
 type Uploader struct {
 \tclient *Client
 }
@@ -20,6 +24,11 @@ func (u *Uploader) Put(ctx context.Context, r io.Reader) error {
 \tif err := u.client.Put(ctx, r); err != nil {
+\t\tvar terr *TransientError
+\t\tif errors.As(err, &terr) {
+\t\t\treturn u.retry(ctx, r)
+\t\t}
 \t\treturn fmt.Errorf("put: %w", err)
 \t}
 \treturn nil
`;

const SMOKE = !!process.env.MEAT_SMOKE;

// End-to-end: resolves the configured default model, then drives the REAL
// abridgeViaSubagent (the production lifecycle path: turn guard, abort wiring,
// Promise.race) rather than reimplementing it, so a regression there is caught.
describe.skipIf(!SMOKE)("meat end-to-end (real model)", () => {
	it("abridges a diff via a sub-agent on the configured provider", async () => {
		const probe = await createAgentSession({ sessionManager: SessionManager.inMemory() });
		const model = probe.session.model as Model<any> | undefined;
		probe.session.dispose();
		if (!model) throw new Error("no default model configured");

		const lines = SAMPLE_DIFF.replace(/\n$/, "").split("\n");
		const numberedDiff = numberDiff(SAMPLE_DIFF);

		const plan = await abridgeViaSubagent({
			cwd: process.cwd(),
			rawDiff: SAMPLE_DIFF,
			numberedDiff,
			totalLines: lines.length,
			model,
		});

		expect(plan.summary.trim().length).toBeGreaterThan(0);
		// An empty remove/fold/replace plan is valid: after imports are stripped,
		// a mostly-signal diff can leave the model nothing to cut.

		const compiled = compilePlan(SAMPLE_DIFF, plan);
		// Guarantee: every non-marker output line is a real original line, possibly
		// with a compiler-generated fold row (marker + indent + "...").
		const original = new Set(lines);
		for (const out of compiled.abridged.split("\n")) {
			if (out.startsWith("\u22ef")) continue; // elision marker
			if (/^[ +\-].*\.\.\.$/.test(out)) continue; // fold row
			expect(original.has(out)).toBe(true);
		}
		// The abridge keeps fewer than all changed lines (imports are stripped)
		// but more than zero.
		expect(compiled.visibleChanged).toBeLessThan(compiled.totalChanged);
		expect(compiled.visibleChanged).toBeGreaterThan(0);
		// The signal line (the new errors.As branch) must survive.
		expect(compiled.abridged).toContain("errors.As");

		// eslint-disable-next-line no-console
		console.log("\n--- meat smoke on", `${model.provider}/${model.id}`, "---");
		// eslint-disable-next-line no-console
		console.log("summary :", compiled.summary);
		// eslint-disable-next-line no-console
		console.log("manifest:", manifestLine(compiled));
		// eslint-disable-next-line no-console
		console.log("reading diff:\n" + compiled.abridged + "\n");
	}, 120_000);
});
