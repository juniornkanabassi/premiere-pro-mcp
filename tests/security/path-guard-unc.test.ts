// Windows UNC parsing in the symlink preflight, on any platform: the filesystem is mocked (round 2 nit).
import { afterEach, describe, expect, it, vi } from "vitest";

const links = new Set(["\\\\server\\share\\linked"]);
vi.mock("node:fs", () => ({
  lstatSync: (path: string) => {
    if (links.has(path)) return { isSymbolicLink: () => true, isDirectory: () => false };
    if (path === "\\\\server\\share\\" || path === "\\\\server\\share\\media") return { isSymbolicLink: () => false, isDirectory: () => true };
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
  readlinkSync: () => { throw new Error("not a link"); },
}));
const { findSymlinkedSegment } = await import("../../src/security/path-guard.js");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); });

describe("Windows UNC paths in the symlink preflight", () => {
  it("walks a backslash UNC path and finds a linked share folder", () => {
    expect(findSymlinkedSegment("\\\\server\\share\\linked\\out.mp4")).toBe("\\\\server\\share\\linked");
    expect(findSymlinkedSegment("\\\\server\\share\\media\\out.mp4")).toBeNull();
  });
  it("parses the panel's forward-slash //host/share form as UNC on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(findSymlinkedSegment("//server/share/linked/out.mp4")).toBe("\\\\server\\share\\linked");
  });
});
