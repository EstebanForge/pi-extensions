import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoldfish } from "./goldfish.js";

const SKILL_MD = /^---\r?\n([\s\S]*?)\r?\n---/;

// `description` is a folded (>-) YAML scalar: first line may carry the value,
// continuation lines are indented and fold to spaces.
function scalarField(frontmatter: string, field: string): string | undefined {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`${field}:`));
  if (start === -1) return undefined;
  const first = lines[start].slice(field.length + 1).trim();
  const folded: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^\s+\S/.test(lines[i])) break;
    folded.push(lines[i].trim());
  }
  return [first.replace(/^>-?\s*/, ""), ...folded].join(" ").trim() || undefined;
}

export default function (pi: ExtensionAPI) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { arm } = registerGoldfish(pi, root);
  const skillsDir = join(root, "skills");
  for (const entry of readdirSync(skillsDir).sort()) {
    const skillPath = join(skillsDir, entry, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const frontmatter = SKILL_MD.exec(readFileSync(skillPath, "utf8"))?.[1] ?? "";
    const name = scalarField(frontmatter, "name") ?? entry;
    pi.registerCommand(name, {
      description:
        scalarField(frontmatter, "description") ?? `Run the EGM ${name} skill`,
      // Command handlers cannot start a run themselves (sendUserMessage is
      // session-scoped; injected followUp messages die in print mode), so the
      // fleet pattern is prefilling the editor for the user to submit.
      handler: async (args, ctx) => {
        const request = args.trim();
        const prompt = [
          `Run the Elephant-Goldfish Model skill \`${name}\`: read ${skillPath} and follow it exactly, including the Pi notes it points to.`,
          request ? `User request: ${request}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        if (ctx.mode !== "tui") {
          ctx.ui.notify(`EGM commands need an interactive session. Headless: read ${skillPath} directly.`, "warning");
          return;
        }
        arm();
        ctx.ui.setEditorText(prompt);
      },
    });
  }
}
