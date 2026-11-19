// Companion remains the only writer unless the operator restarts in native mode.
// Read-only means both: Companion's manifest marks the command readOnly: true (1.11.0 on), and it still has the verb, argument
// types and positional bindings of a known Companion 1.11.0 read below. A renamed, remapped, retyped or extended command is a writer.
const READ_CONTRACT: Record<string, [argv: string, properties: string, positional: string]> = {
  status: ["status", "", ""], bins: ["bins", "project:string", ""], sequence_list: ["sequence list", "project:string", ""],
  marker_list: ["marker list", "sequence:string,project:string", "sequence"], job: ["job", "id:string", "id"], roots_list: ["roots list", "", ""],
  presets_export: ["presets export", "detail:boolean", ""], presets_effects: ["presets effects", "", ""],
  presets_show: ["presets show", "name:string,effect:boolean,folder:string", "name"], timeline: ["timeline", "sequence:string,project:string", "sequence"],
  effect_available: ["effect available", "project:string", ""],
  effect_list: ["effect list", "sequence:string,track:string,index:integer,at:string,clip:string,project:string", "sequence"],
  colour_status: ["colour status", "path:string", "path"], export_status: ["export status", "id:string", "id"],
};
export interface CompanionCommand { name: string; argv: string[]; positional?: string[]; readOnly?: boolean; inputSchema: { properties: Record<string, unknown> } }
export function isCompanionRead(tool: CompanionCommand): boolean {
  const contract = Object.hasOwn(READ_CONTRACT, tool.name) ? READ_CONTRACT[tool.name] : undefined;
  if (tool.readOnly !== true || !contract || tool.argv.join(" ") !== contract[0]) return false;
  const keys = Object.keys(tool.inputSchema.properties);
  // A read may drop arguments, but each one left keeps its 1.11.0 type and stays positional exactly when it was.
  return keys.every(key => contract[1].split(",").includes(`${key}:${(tool.inputSchema.properties[key] as { type?: unknown }).type}`))
    && tool.positional?.join(",") === contract[2].split(",").filter(key => keys.includes(key)).join(",");
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
