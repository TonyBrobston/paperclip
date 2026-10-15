import { describe, expect, it } from "vitest";
import { isPluginInstallPathSyntax } from "./plugin-install-source.js";

describe("isPluginInstallPathSyntax", () => {
  it("recognizes the container paths a self-hosted install is given", () => {
    expect(isPluginInstallPathSyntax("/paperclip/plugins/paperclip-plugin-home-assistant")).toBe(true);
    expect(isPluginInstallPathSyntax("/opt/paperclip-plugin-home-assistant")).toBe(true);
  });

  it("recognizes relative and home-expanded paths in either separator style", () => {
    expect(isPluginInstallPathSyntax("./my-plugin")).toBe(true);
    expect(isPluginInstallPathSyntax("../my-plugin")).toBe(true);
    expect(isPluginInstallPathSyntax(".\\my-plugin")).toBe(true);
    expect(isPluginInstallPathSyntax("..\\my-plugin")).toBe(true);
    expect(isPluginInstallPathSyntax("~/my-plugin")).toBe(true);
  });

  it("recognizes Windows drive-letter paths", () => {
    expect(isPluginInstallPathSyntax("C:\\plugins\\my-plugin")).toBe(true);
    expect(isPluginInstallPathSyntax("c:/plugins/my-plugin")).toBe(true);
  });

  it("ignores surrounding whitespace from a pasted path", () => {
    expect(isPluginInstallPathSyntax("  /paperclip/plugins/my-plugin  ")).toBe(true);
  });

  it("treats npm package specifiers as packages, not paths", () => {
    expect(isPluginInstallPathSyntax("paperclip-plugin-home-assistant")).toBe(false);
    expect(isPluginInstallPathSyntax("@paperclipai/plugin-example")).toBe(false);
    expect(isPluginInstallPathSyntax("@paperclipai/plugin-example@1.2.3")).toBe(false);
  });

  it("does not mistake a scoped name or an empty box for a path", () => {
    expect(isPluginInstallPathSyntax("")).toBe(false);
    expect(isPluginInstallPathSyntax("   ")).toBe(false);
    expect(isPluginInstallPathSyntax("@scope/name")).toBe(false);
  });
});
