import { describe, test, expect } from "bun:test";
import { parseTomlScalars, tomlTables } from "../../../src/model/import/toml-lite";

describe("parseTomlScalars", () => {
  test("解析表头下的标量赋值，路径以点分展开", () => {
    const scalars = parseTomlScalars(`
model_provider = "custom"
model = "glm-5.1"

[model_providers.custom]
name = "custom"
wire_api = "responses"
base_url = "https://aigw.example.com:8443/v1"
`);
    expect(scalars["model_provider"]).toBe("custom");
    expect(scalars["model"]).toBe("glm-5.1");
    expect(scalars["model_providers.custom.base_url"]).toBe(
      "https://aigw.example.com:8443/v1",
    );
    expect(scalars["model_providers.custom.wire_api"]).toBe("responses");
  });

  test("行尾注释被剥掉，引号内的 # 保留", () => {
    const scalars = parseTomlScalars(`
# 整行注释
name = "a#b" # 行尾注释
url = "https://example.com/#frag"
`);
    expect(scalars.name).toBe("a#b");
    expect(scalars.url).toBe("https://example.com/#frag");
  });

  test("布尔与数字按标量解析", () => {
    const scalars = parseTomlScalars(`
flag = true
off = false
port = 8443
ratio = 1.5
`);
    expect(scalars.flag).toBe(true);
    expect(scalars.off).toBe(false);
    expect(scalars.port).toBe(8443);
    expect(scalars.ratio).toBe(1.5);
  });

  test("基本串转义还原，字面串原样保留", () => {
    const scalars = parseTomlScalars(String.raw`
basic = "a\"b\\c\nd"
literal = 'a\b'
`);
    expect(scalars.basic).toBe('a"b\\c\nd');
    expect(scalars.literal).toBe(String.raw`a\b`);
  });

  test("数组与内联表整段跳过，不误记成标量", () => {
    const scalars = parseTomlScalars(`
args = ["-y", "@modelcontextprotocol/server-time"]
inline = { a = 1 }
after = "kept"
`);
    expect(scalars.args).toBeUndefined();
    expect(scalars.inline).toBeUndefined();
    expect(scalars.after).toBe("kept");
  });

  test("跨行数组被整体跳过，其中的赋值不泄漏", () => {
    const scalars = parseTomlScalars(`
notify = [
  "line-one",
  "line-two",
]
real = "yes"
`);
    expect(scalars.notify).toBeUndefined();
    expect(scalars["notify.0"]).toBeUndefined();
    expect(scalars.real).toBe("yes");
  });

  test("带引号的表名与键名剥掉引号后作路径", () => {
    const scalars = parseTomlScalars(`
[plugins."computer-use@openai-bundled"]
enabled = true
`);
    expect(scalars['plugins."computer-use@openai-bundled".enabled']).toBeUndefined();
    expect(scalars["plugins.computer-use@openai-bundled.enabled"]).toBe(true);
  });

  test("数组表 [[x]] 只用来更新路径前缀", () => {
    const scalars = parseTomlScalars(`
[[items]]
name = "first"

[[items]]
name = "second"
`);
    expect(scalars["items.name"]).toBe("second");
  });
});

describe("tomlTables", () => {
  test("只收子表的直接标量键，不展开更深层级", () => {
    const scalars = parseTomlScalars(`
[model_providers.custom]
name = "custom"
base_url = "https://example.com/v1"

[model_providers.custom.nested]
ignored = "yes"

[mcp_servers.time]
command = "npx"
`);
    const tables = tomlTables(scalars, "model_providers");
    expect(Object.keys(tables)).toEqual(["custom"]);
    expect(tables.custom).toEqual({ name: "custom", base_url: "https://example.com/v1" });
    expect(tables.custom.nested).toBeUndefined();
  });

  test("前缀下的直接标量不归属任何子表", () => {
    const scalars = parseTomlScalars(`
model = "glm-5.1"
[model_providers.a]
base_url = "https://a.example.com/v1"
`);
    const tables = tomlTables(scalars, "model_providers");
    expect(tables.a).toEqual({ base_url: "https://a.example.com/v1" });
    expect(tables.model).toBeUndefined();
  });

  test("前缀不存在时返回空表", () => {
    expect(tomlTables(parseTomlScalars('a = "1"'), "nothing")).toEqual({});
  });
});