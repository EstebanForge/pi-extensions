import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { confirmWrite } from "../confirm";
import { CUSTOM_FIELDS_OPT_FIELDS, resolveField, type ResolvedField } from "../custom-fields";
import { fmtTask } from "../resolve";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaCustomField, AsanaTaskCompact } from "../types";
import {
  BATCH_SET_CUSTOM_FIELDS_TITLE,
  BATCH_SET_CUSTOM_FIELDS_DESCRIPTION,
  BATCH_SET_CUSTOM_FIELDS_TASKS_DESCRIPTION,
} from "../prompts";

// Set custom fields on MANY tasks in one gated write. Backfill sweeps (effort
// estimates across a sprint, status flips for a batch of tickets) otherwise
// mean repeating asana_set_custom_fields N times, so the human confirms N
// dialogs. This tool resolves every name to a gid across every task, shows
// ONE review table, then writes task by task with per-task results.
//
// All-or-nothing on RESOLUTION: if any field name is unknown or ambiguous on
// its task, nothing writes and the agent gets the full error list to fix.
// Writes themselves are per-task and sequential (Asana rate limits punish
// parallel PUTs); a mid-batch failure does not roll back earlier successes,
// so the result reports per-task status explicitly.

const FieldValue = Type.Union([Type.String(), Type.Number(), Type.Null()]);

const TaskEntry = Type.Object({
  gid: Type.String({ description: "Task GID (e.g. \"1234567890123456\")." }),
  fields: Type.Record(Type.String(), FieldValue, {
    description: "Map of { field_name: value } for THIS task. Same rules as asana_set_custom_fields.",
  }),
});

const Params = Type.Object({
  tasks: Type.Array(TaskEntry, {
    description: BATCH_SET_CUSTOM_FIELDS_TASKS_DESCRIPTION,
    minItems: 1,
    maxItems: 50,
  }),
});

interface PlannedTask {
  gid: string;
  fields: ResolvedField[];
  body: Record<string, string | number | null>;
}

export const batchSetCustomFieldsTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_batch_set_custom_fields",
  label: BATCH_SET_CUSTOM_FIELDS_TITLE,
  description: BATCH_SET_CUSTOM_FIELDS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<AsanaDetails>> {
    // Dedupe by gid: a repeated gid would resolve and write twice, and Asana
    // applies the LAST write, so keep the final entry.
    const byGid = new Map<string, (typeof params.tasks)[number]>();
    for (const t of params.tasks) byGid.set(t.gid, t);
    const entries = [...byGid.values()];

    const totalFields = entries.reduce((n, t) => n + Object.keys(t.fields).length, 0);
    if (totalFields === 0) {
      return toToolResult(
        "Asana: no fields supplied to asana_batch_set_custom_fields. Each task needs a non-empty fields map.",
      );
    }

    // Fetch every task's projection concurrently (reads only, safe to fan
    // out). The projection already carries name + permalink_url, so no second
    // resolution pass is needed for the table labels.
    const projections = await Promise.all(
      entries.map(async (t): Promise<AsanaTaskCompact | AsanaError> => {
        try {
          return await callAsana<AsanaTaskCompact>(
            "GET",
            `/tasks/${encodeURIComponent(t.gid)}`,
            { query: { opt_fields: CUSTOM_FIELDS_OPT_FIELDS } },
          );
        } catch (err) {
          return err instanceof AsanaError ? err : new AsanaError(errorText(err), 0);
        }
      }),
    );
    const refs = new Map(
      projections.flatMap((p) =>
        p instanceof AsanaError
          ? []
          : [[p.gid, { name: p.name, permalink_url: p.permalink_url }] as const],
      ),
    );

    // Resolve fields per task. Any resolution failure aborts the whole batch
    // BEFORE the gate: a half-planned table is exactly what the human should
    // not have to review.
    const planned: PlannedTask[] = [];
    const errors: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const task = projections[i];
      if (task instanceof AsanaError) {
        errors.push(
          `${fmtTask(entry.gid, refs.get(entry.gid))}: task fetch failed (${errorText(task)})`,
        );
        continue;
      }
      const fields = (task.custom_fields ?? []) as unknown as AsanaCustomField[];
      if (Object.keys(entry.fields).length === 0) {
        errors.push(`${fmtTask(entry.gid, refs.get(entry.gid))}: empty fields map`);
        continue;
      }
      const resolved: ResolvedField[] = [];
      for (const [key, value] of Object.entries(entry.fields)) {
        const result = resolveField(key, value, fields);
        if (result.ok) resolved.push(result.field);
        else errors.push(`${fmtTask(entry.gid, refs.get(entry.gid))} - ${key}: ${result.error}`);
      }
      if (resolved.length > 0 && resolved.length === Object.keys(entry.fields).length) {
        const body: Record<string, string | number | null> = {};
        for (const r of resolved) body[r.gid] = r.sendValue;
        planned.push({ gid: entry.gid, fields: resolved, body });
      }
    }
    if (errors.length > 0) {
      return toToolResult(
        `Asana: aborted batch set; nothing was written. Fix these and retry:\n` +
          errors.map((e) => `- ${e}`).join("\n"),
      );
    }

    // One gate for the whole table. Task lines carry the resolved name +
    // permalink; field lines mirror the single-task tool's rendering.
    const tableLines: string[] = [];
    for (const p of planned) {
      tableLines.push(`task: ${fmtTask(p.gid, refs.get(p.gid))}`);
      for (const r of p.fields) tableLines.push(`  ${r.summary}`);
    }
    const decision = await confirmWrite(ctx, {
      title: `Set ${totalFields} custom field${
        totalFields === 1 ? "" : "s"
      } across ${planned.length} task${planned.length === 1 ? "" : "s"}?`,
      summary: tableLines.join("\n"),
    });
    if (!decision.proceed) {
      return toToolResult(
        `Asana: batch_set_custom_fields cancelled by user. Nothing was changed.`,
      );
    }

    // Sequential writes with per-task status; no rollback of earlier
    // successes, so the result names every failure explicitly.
    const okLines: string[] = [];
    const failLines: string[] = [];
    for (const p of planned) {
      try {
        const updated = await callAsana<AsanaTaskCompact>(
          "PUT",
          `/tasks/${encodeURIComponent(p.gid)}`,
          {
            query: {
              opt_fields:
                "name,custom_fields.name,custom_fields.display_value,custom_fields.gid",
            },
            body: { custom_fields: p.body },
          },
        );
        const after = (updated.custom_fields ?? []) as unknown as AsanaCustomField[];
        const byFieldGid = new Map(after.map((f) => [f.gid, f]));
        const values = p.fields
          .map((r) => `${r.name} = ${byFieldGid.get(r.gid)?.display_value ?? "(empty)"}`)
          .join(", ");
        okLines.push(`- ${updated.name ?? p.gid}: ${values}`);
      } catch (err) {
        failLines.push(`- ${fmtTask(p.gid, refs.get(p.gid))}: ${errorText(err)}`);
      }
    }

    const lines: string[] = [
      `Asana: batch set ${totalFields} field${
        totalFields === 1 ? "" : "s"
      }: ${okLines.length}/${planned.length} task${planned.length === 1 ? "" : "s"} updated.`,
      ...okLines,
      ...failLines,
    ];
    return toToolResult(lines.join("\n"));
  },
};
