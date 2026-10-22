import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SandboxSettingsPanel } from "@/components/settings/components/sandbox-settings";

describe("SandboxSettingsPanel", () => {
  test("设置页能渲染出沙箱档位、网络与 Windows 说明", () => {
    const html = renderToStaticMarkup(<SandboxSettingsPanel />);
    expect(html).toContain("沙箱");
    expect(html).toContain("工作区");
    expect(html).toContain("网络");
    expect(html).toContain("Windows");
  });
});
