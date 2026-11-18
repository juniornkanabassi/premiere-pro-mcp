// Companion remains the only writer unless the operator restarts in native mode.
// Read-only means both: Companion's manifest marks the command readOnly: true (1.11.0 on), and it still has the verb and
// arguments of a known Companion 1.11.0 read below. A renamed, remapped or extended command is a writer.
const READ_CONTRACT: Record<string, [argv: string, properties: string]> = {
  status: ["status", ""], bins: ["bins", "project"], sequence_list: ["sequence list", "project"], marker_list: ["marker list", "sequence,project"],
  job: ["job", "id"], roots_list: ["roots list", ""], presets_export: ["presets export", "detail"], presets_effects: ["presets effects", ""],
  presets_show: ["presets show", "name,effect,folder"], timeline: ["timeline", "sequence,project"], effect_available: ["effect available", "project"],
  effect_list: ["effect list", "sequence,track,index,at,clip,project"], colour_status: ["colour status", "path"], export_status: ["export status", "id"],
};
export interface CompanionCommand { name: string; argv: string[]; readOnly?: boolean; inputSchema: { properties: Record<string, unknown> } }
export function isCompanionRead(tool: CompanionCommand): boolean {
  const contract = Object.hasOwn(READ_CONTRACT, tool.name) ? READ_CONTRACT[tool.name] : undefined;
  return tool.readOnly === true && !!contract && tool.argv.join(" ") === contract[0]
    && Object.keys(tool.inputSchema.properties).every(key => contract[1].split(",").includes(key));
}
const companionReadOnly = new Set<string>();
export function setCompanionReadOnly(tools: readonly CompanionCommand[]): void {
  companionReadOnly.clear();
  for (const tool of tools) if (isCompanionRead(tool)) companionReadOnly.add(tool.name);
}

export function companionAuthority(name: string): readonly ("inspect" | "edit" | "export" | "filesystem")[] | undefined {
  if (!name.startsWith("companion_")) return undefined;
  return companionReadOnly.has(name.slice(10))
    ? ["inspect"] : ["inspect", "edit", "export", "filesystem"];
}

export function companionWriter(): "companion" | "native" | undefined {
  if (!process.env.PREMIERE_COMPANION_CLI) return undefined;
  const mode = process.env.PREMIERE_MCP_WRITER ?? "companion";
  if (mode !== "companion" && mode !== "native") throw new Error("PREMIERE_MCP_WRITER must be companion or native");
  return mode;
}

export function writerPermits(name: string, mutating: boolean): boolean {
  const writer = companionWriter();
  return !mutating || !writer || (name.startsWith("companion_") ? writer === "companion" : writer === "native");
}

// Read-only planners shown beside Companion in the Shorts profile. They never call Premiere.
export const SHORTS_PLANNERS = ["detect_repeated_takes", "plan_pause_tightening", "plan_filler_word_removal", "convert_timeline_time"] as const;

/** The Shorts profile's explicit tool list: every manifest command, then the planners. */
export function shortsToolList(manifestTools: readonly { name: string }[]): string {
  return [...manifestTools.map(tool => "companion_" + tool.name), ...SHORTS_PLANNERS].join(",");
}
