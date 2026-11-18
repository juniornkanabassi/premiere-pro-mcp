// Companion remains the only writer unless the operator restarts in native mode.
// Read-only commands are the ones Companion's own manifest marks readOnly: true (1.11.0 on); a command without the flag is a writer,
// so a renamed or remapped command can never keep inspect-only authority by its name alone.
const companionReadOnly = new Set<string>();
export function setCompanionReadOnly(names: Iterable<string>): void {
  companionReadOnly.clear();
  for (const name of names) companionReadOnly.add(name);
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
