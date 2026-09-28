import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attachImageToBody,
  buildEditsRequest,
  buildImageGenTool,
  buildImagesRequest,
  clampN,
  parseGenerationItems,
  resolveInputImage,
  sniffImageMime,
} from "../../src/tools/imagegen-tool";
import { DEFAULT_IMAGEGEN_CONFIG, resetImageGenConfigForTest } from "../../src/tools/imagegen-config";
import {
  credentialSet,
  initLocalStorage,
  resetStorageForTest,
} from "../../src/storage/hostdb";

/**
 * 生图请求走 sidecar 直连 fetch（fetch_models 先例，不经宿主通道），
 * 因此这里 stub globalThis.fetch 即可覆盖各分支（b64 直取 / url 下载 /
 * 图生图 generations+image 与 edits multipart 回落）。
 * 端点解析走 deps 缝隙（resolveEndpoint），底图与成图落盘走 cwd 缝隙，
 * 都不 mock 模块；临时工作目录避免污染仓库。
 */
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const cfgBase = {
  ...DEFAULT_IMAGEGEN_CONFIG,
  enabled: true,
  provider: "t-gw",
  modelId: "gpt-image-test",
  size: "1024x1024",
};

const fakeEndpoint = () => "https://gw.test/v1/";

/** 假工作区：成图落盘与底图相对路径都指向这里，不污染仓库 */
const tmpCwd = mkdtempSync(path.join(tmpdir(), "pi-agent-imagegen-ws-"));

const textOf = (res: { content: unknown[] }): string =>
  (res.content[0] as { text?: string } | undefined)?.text ?? "";

type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };
const calls: Recorded[] = [];

function stubFetch(handler: (req: Recorded) => Promise<Response> | Response): void {
  (globalThis as { fetch: unknown }).fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const rec: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      // edits 回落带 FormData body，只有字符串才按 JSON 解
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    };
    calls.push(rec);
    return handler(rec);
  };
}

const jsonResponse = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let origFetch: typeof globalThis.fetch;

beforeAll(() => {
  origFetch = globalThis.fetch;
  initLocalStorage(path.join(mkdtempSync(path.join(tmpdir(), "pi-agent-imagegen-tool-")), "state.db"));
});

afterAll(() => {
  globalThis.fetch = origFetch;
  resetImageGenConfigForTest();
  resetStorageForTest();
});

describe("buildImagesRequest", () => {
  test("url 拼接剥尾斜杠；Bearer 与 Content-Type 就位", () => {
    const req = buildImagesRequest(
      cfgBase,
      { prompt: "banner" },
      "https://gw.test/v1///",
      "sk-abc",
    );
    expect(req.url).toBe("https://gw.test/v1/images/generations");
    expect(req.headers.Authorization).toBe("Bearer sk-abc");
    expect(req.headers["Content-Type"]).toBe("application/json");
  });

  test("size 显式值优先，缺省回落配置；response_format 恒带；output_format 仅在显式 format 时", () => {
    const def = buildImagesRequest(cfgBase, { prompt: "x" }, "https://gw/v1", "k");
    expect(def.body).toEqual({
      model: "gpt-image-test",
      prompt: "x",
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
    });
    const full = buildImagesRequest(
      cfgBase,
      { prompt: "x", size: "1792x1024", format: "jpeg" },
      "https://gw/v1",
      "k",
    );
    expect(full.body.size).toBe("1792x1024");
    expect(full.body.output_format).toBe("jpeg");
  });

  test("n 透传并过 clampN：缺省 1、2 原样、99 → 10", () => {
    expect(buildImagesRequest(cfgBase, { prompt: "x" }, "https://gw/v1", "k").body.n).toBe(1);
    expect(
      buildImagesRequest(cfgBase, { prompt: "x", n: 2 }, "https://gw/v1", "k").body.n,
    ).toBe(2);
    expect(
      buildImagesRequest(cfgBase, { prompt: "x", n: 99 }, "https://gw/v1", "k").body.n,
    ).toBe(10);
  });
});

describe("parseGenerationItems", () => {
  test("b64_json 优先；仅 url 也算成功；无数据返回空数组", () => {
    expect(
      parseGenerationItems({ data: [{ b64_json: "AAA", url: "https://x/y" }] }),
    ).toEqual([{ b64: "AAA", url: "https://x/y" }]);
    expect(parseGenerationItems({ data: [{ url: " https://x/y " }] })).toEqual([
      { b64: undefined, url: "https://x/y" },
    ]);
    expect(parseGenerationItems({ data: [] })).toEqual([]);
    expect(parseGenerationItems(null)).toEqual([]);
    expect(parseGenerationItems({ data: [{}] })).toEqual([]);
  });

  test("批量：data[] 全部有效条目按序返回，缺数据的条目跳过", () => {
    expect(
      parseGenerationItems({ data: [{ b64_json: "A" }, {}, { url: "https://x/b" }, { b64_json: "C" }] }),
    ).toEqual([{ b64: "A", url: undefined }, { b64: undefined, url: "https://x/b" }, { b64: "C", url: undefined }]);
  });
});

describe("clampN", () => {
  test("非法/缺省 → 1；越界 clamp 到 1..10；小数向下取整", () => {
    expect(clampN(undefined)).toBe(1);
    expect(clampN(0)).toBe(1);
    expect(clampN(-3)).toBe(1);
    expect(clampN(NaN)).toBe(1);
    expect(clampN("4" as unknown)).toBe(1);
    expect(clampN(2.7)).toBe(2);
    expect(clampN(5)).toBe(5);
    expect(clampN(99)).toBe(10);
  });
});

describe("sniffImageMime", () => {
  const b64of = (bytes: number[]) => Buffer.from(bytes).toString("base64");
  test("png/jpeg/webp/gif 魔数各归其位，乱码回落 png", () => {
    expect(sniffImageMime(PNG_1x1)).toBe("image/png");
    expect(sniffImageMime(b64of([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 1, 2, 3]))).toBe("image/jpeg");
    expect(
      sniffImageMime(
        b64of([...Buffer.from("RIFF"), 8, 0, 0, 0, ...Buffer.from("WEBP"), 1, 2, 3, 4]),
      ),
    ).toBe("image/webp");
    expect(sniffImageMime(b64of([...Buffer.from("GIF89a"), 1, 2, 3]))).toBe("image/gif");
    expect(sniffImageMime(b64of([1, 2, 3, 4, 5, 6]))).toBe("image/png");
  });
});

describe("generate_image 门控（不触网）", () => {
  test("未启用 → 婉拒指向设置", async () => {
    resetImageGenConfigForTest({ ...cfgBase, enabled: false });
    const res = await buildImageGenTool().execute("c1", { prompt: "x" }, undefined);
    expect(textOf(res)).toContain("未启用");
    expect(textOf(res)).toContain("设置");
  });

  test("启用但模型未配置 → 婉拒", async () => {
    resetImageGenConfigForTest({ ...cfgBase, provider: "" });
    const res = await buildImageGenTool().execute("c2", { prompt: "x" }, undefined);
    expect(textOf(res)).toContain("尚未配置");
  });

  test("端点缺失 → 提示 provider 未正确配置", async () => {
    resetImageGenConfigForTest(cfgBase);
    const res = await buildImageGenTool({ resolveEndpoint: () => "" }).execute(
      "c3",
      { prompt: "x" },
      undefined,
    );
    expect(textOf(res)).toContain("缺少端点地址");
  });

  test("无凭据 → 提示去「模型」页配密钥", async () => {
    resetImageGenConfigForTest({ ...cfgBase, provider: "no-cred-provider" });
    const res = await buildImageGenTool({ resolveEndpoint: fakeEndpoint, cwd: tmpCwd }).execute(
      "c4",
      { prompt: "x" },
      undefined,
    );
    expect(textOf(res)).toContain("未配置 API 密钥");
  });

  test("空 prompt 抛参数错误", async () => {
    resetImageGenConfigForTest(cfgBase);
    await expect(
      buildImageGenTool().execute("c5", { prompt: "  " }, undefined),
    ).rejects.toThrow("prompt is required");
  });
});

describe("generate_image 执行（stub fetch）", () => {
  test("b64 直取：请求形状 + image 块 + headline", async () => {
    resetImageGenConfigForTest(cfgBase);
    await credentialSet("t-gw", "sk-test");
    calls.length = 0;
    stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_1x1 }] }));
    const tool = buildImageGenTool({ resolveEndpoint: fakeEndpoint, cwd: tmpCwd });
    const res = await tool.execute("c6", { prompt: "科技蓝 banner" }, undefined);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://gw.test/v1/images/generations");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-test");
    expect(calls[0].body).toMatchObject({
      model: "gpt-image-test",
      prompt: "科技蓝 banner",
      size: "1024x1024",
      response_format: "b64_json",
    });
    expect(textOf(res)).toContain("已生成图片");
    expect(res.content[1]).toEqual({
      type: "image",
      data: PNG_1x1,
      mimeType: "image/png",
    });
    // 投影链路接缝：图片块能被闸门收进 data-image（id 归属 toolCallId）
    const { images } = (await import("../../src/tools/image-parts")).projectToolResult(
      res.content as never,
      { toolCallId: "c6", toolName: "generate_image" },
    );
    expect(images[0].id).toBe("img-c6-0");
  });

  test("仅 url：下载一次转 base64，content-type 归一（image/jpg→jpeg）", async () => {
    const pngBytes = Buffer.from(PNG_1x1, "base64");
    stubFetch((req) =>
      req.method === "POST"
        ? jsonResponse({ data: [{ url: "https://cdn.test/img.png" }] })
        : new Response(pngBytes, { status: 200, headers: { "Content-Type": "image/jpeg;charset=binary" } }),
    );
    resetImageGenConfigForTest(cfgBase);
    await credentialSet("t-gw", "sk-test");
    calls.length = 0;
    const tool = buildImageGenTool({ resolveEndpoint: fakeEndpoint, cwd: tmpCwd });
    const res = await tool.execute("c7", { prompt: "x", format: "jpeg" }, undefined);
    expect(calls.length).toBe(2);
    expect(calls[1].url).toBe("https://cdn.test/img.png");
    // content-type 声明（白名单内）优先于魔数嗅探
    expect(res.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: PNG_1x1 });
    expect((calls[0].body as Record<string, unknown>).output_format).toBe("jpeg");
  });

  test("非 2xx：错误文本带状态与服务商 message，不抛栈", async () => {
    stubFetch(() => jsonResponse({ error: { message: "model not found" } }, 404));
    resetImageGenConfigForTest(cfgBase);
    await credentialSet("t-gw", "sk-test");
    const tool = buildImageGenTool({ resolveEndpoint: fakeEndpoint, cwd: tmpCwd });
    const res = await tool.execute("c8", { prompt: "x" }, undefined);
    expect(textOf(res)).toContain("HTTP 404");
    expect(textOf(res)).toContain("model not found");
  });

  test("200 但无图：给出可转述文本（带 error 详情）", async () => {
    stubFetch(() => jsonResponse({ data: [] }));
    resetImageGenConfigForTest(cfgBase);
    await credentialSet("t-gw", "sk-test");
    const tool = buildImageGenTool({ resolveEndpoint: fakeEndpoint, cwd: tmpCwd });
    const res = await tool.execute("c9", { prompt: "x" }, undefined);
    expect(textOf(res)).toContain("没有图片数据");
  });

  test("网络异常：错误文本而不是栈", async () => {
    globalThis.fetch = (async () => {
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;
    resetImageGenConfigForTest(cfgBase);
    await credentialSet("t-gw", "sk-test");
    const tool = buildImageGenTool({ resolveEndpoint: fakeEndpoint, cwd: tmpCwd });
    const res = await tool.execute("c10", { prompt: "x" }, undefined);
    expect(textOf(res)).toContain("文生图请求失败");
    expect(textOf(res)).toContain("Connection refused");
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
  });
});

describe("generate_image 批量出图 n（stub fetch）", () => {
  beforeAll(async () => {
    resetImageGenConfigForTest(cfgBase);
    await credentialSet("t-gw", "sk-test");
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
  });

  test("n=2 双 b64：一张请求两个 image 块、两行落盘、同一 toolCallId 归组", async () => {
    stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_1x1 }, { b64_json: PNG_1x1 }] }));
    calls.length = 0;
    const tool = buildImageGenTool({ resolveEndpoint: fakeEndpoint, cwd: tmpCwd });
    const res = await tool.execute("c11", { prompt: "海报 x2", n: 2 }, undefined);
    expect(calls.length).toBe(1);
    expect((calls[0].body as Record<string, unknown>).n).toBe(2);
    expect(textOf(res)).toContain("已生成 2 张图片");
    expect(textOf(res)).toContain("合计约");
    expect(res.content[1]).toEqual({ type: "image", data: PNG_1x1, mimeType: "image/png" });
    expect(res.content[2]).toEqual({ type: "image", data: PNG_1x1, mimeType: "image/png" });
    const details = res.details as { count?: number; paths?: string[] };
    expect(details.count).toBe(2);
    const paths = details.paths ?? [];
    expect(paths.length).toBe(2);
    for (const p of paths) expect(existsSync(p)).toBe(true);
    // 同毫秒批量靠序号后缀防覆盖：第二份带 -1 段
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths[1]).toMatch(/-1-gpt-image-test\.png$/);
    expect(textOf(res)).toContain(paths[0]);
    expect(textOf(res)).toContain(paths[1]);
    // 投影管线：同一工具结果两张图都过闸，id 按行内序号区分（前端按 toolCallId 归组一行）
    const { images } = (await import("../../src/tools/image-parts")).projectToolResult(
      res.content as never,
      { toolCallId: "c11", toolName: "generate_image" },
    );
    expect(images.map((im) => im.id)).toEqual(["img-c11-0", "img-c11-1"]);
  });

  test("网关静默少回：n=3 只回 2 张 → 文案如实报告缺口", async () => {
    stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_1x1 }, { b64_json: PNG_1x1 }] }));
    calls.length = 0;
    const tool = buildImageGenTool({ resolveEndpoint: fakeEndpoint, cwd: tmpCwd });
    const res = await tool.execute("c12", { prompt: "x", n: 3 }, undefined);
    expect((calls[0].body as Record<string, unknown>).n).toBe(3);
    expect(textOf(res)).toContain("已生成 2 张图片");
    expect(textOf(res)).toContain("请求 3 张，网关仅回 2 张");
  });

  test("单张下载失败不拖垮整批：坏图记账、好图上屏", async () => {
    stubFetch((req) =>
      req.method === "POST"
        ? jsonResponse({ data: [{ b64_json: PNG_1x1 }, { url: "https://cdn.test/fail.png" }] })
        : new Response("nope", { status: 404 }),
    );
    const tool = buildImageGenTool({ resolveEndpoint: fakeEndpoint, cwd: tmpCwd });
    const res = await tool.execute("c13", { prompt: "x", n: 2 }, undefined);
    expect(res.content.length).toBe(2); // 文本 + 1 张好图
    expect(textOf(res)).toContain("1 张结果获取失败");
    expect(textOf(res)).toContain("第 2 张下载失败 HTTP 404");
  });
});

describe("图生图纯函数", () => {
  test("attachImageToBody：追加 image 且不改原 body", () => {
    const body = { model: "m", prompt: "p" };
    expect(attachImageToBody(body, "AAA")).toEqual({ model: "m", prompt: "p", image: "AAA" });
    expect(body).toEqual({ model: "m", prompt: "p" });
  });

  test("buildEditsRequest：url 剥尾斜杠 / 仅 Authorization 头 / form 字段与输入文件名", () => {
    const bytes = Buffer.from(PNG_1x1, "base64");
    const req = buildEditsRequest(
      cfgBase,
      { prompt: "夜景", size: "1024x1792" },
      "https://gw/v1//",
      "sk-x",
      bytes,
      "image/png",
    );
    expect(req.url).toBe("https://gw/v1/images/edits");
    expect(req.headers).toEqual({ Authorization: "Bearer sk-x" });
    expect(req.form.get("model")).toBe("gpt-image-test");
    expect(req.form.get("prompt")).toBe("夜景");
    expect(req.form.get("size")).toBe("1024x1792");
    const file = req.form.get("image") as File;
    expect(file.name).toBe("input.png");
    expect(file.type).toBe("image/png");
    // 单图缺省形态不写 n 字段（对旧网关的最大兼容面）
    expect(req.form.get("n")).toBeNull();
  });

  test("buildEditsRequest：n>1 才写 form.n", () => {
    const bytes = Buffer.from(PNG_1x1, "base64");
    const req = buildEditsRequest(
      cfgBase,
      { prompt: "p", n: 3 },
      "https://gw/v1",
      "sk-x",
      bytes,
      "image/png",
    );
    expect(req.form.get("n")).toBe("3");
  });
});

describe("resolveInputImage", () => {
  const noSignal = new AbortController().signal;

  afterAll(() => {
    globalThis.fetch = origFetch;
  });

  test("data URL 直拆；jpg 别名归一 jpeg", async () => {
    expect(await resolveInputImage(`data:image/png;base64,${PNG_1x1}`, tmpCwd, noSignal)).toEqual({
      b64: PNG_1x1,
      mime: "image/png",
    });
    expect(
      await resolveInputImage(`data:image/jpg;base64,${PNG_1x1}`, tmpCwd, noSignal),
    ).toMatchObject({ mime: "image/jpeg" });
  });

  test("本地相对路径读盘；mime 由魔数嗅探", async () => {
    writeFileSync(path.join(tmpCwd, "r-in.png"), Buffer.from(PNG_1x1, "base64"));
    expect(await resolveInputImage("r-in.png", tmpCwd, noSignal)).toEqual({
      b64: PNG_1x1,
      mime: "image/png",
    });
  });

  test("http 下载：content-type 声明优先", async () => {
    stubFetch(() =>
      new Response(Buffer.from(PNG_1x1, "base64"), {
        status: 200,
        headers: { "Content-Type": "image/jpg" },
      }),
    );
    expect(await resolveInputImage("https://cdn.test/in.jpg", tmpCwd, noSignal)).toMatchObject({
      b64: PNG_1x1,
      mime: "image/jpeg",
    });
  });

  test("缺文件 / 下载非 2xx：回可转述 err 而不是抛", async () => {
    const r = await resolveInputImage("missing/nope.png", tmpCwd, noSignal);
    expect((r as { err?: string }).err).toContain("底图读取失败");
    stubFetch(() => new Response("nope", { status: 403 }));
    const d = await resolveInputImage("https://cdn.test/x.png", tmpCwd, noSignal);
    expect((d as { err?: string }).err).toContain("底图下载失败");
    expect((d as { err?: string }).err).toContain("403");
  });
});

describe("generate_image 图生图（stub fetch）", () => {
  const tool = () => buildImageGenTool({ resolveEndpoint: fakeEndpoint, cwd: tmpCwd });

  beforeAll(async () => {
    resetImageGenConfigForTest(cfgBase);
    await credentialSet("t-gw", "sk-test");
    writeFileSync(path.join(tmpCwd, "i2i-input.png"), Buffer.from(PNG_1x1, "base64"));
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
  });

  test("网关吃 generations+image：单次成功且带 image 字段", async () => {
    stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_1x1 }] }));
    calls.length = 0;
    const res = await tool().execute(
      "i1",
      { prompt: "把背景改成夜景", image: `data:image/png;base64,${PNG_1x1}` },
      undefined,
    );
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://gw.test/v1/images/generations");
    expect((calls[0].body as Record<string, unknown>).image).toBe(PNG_1x1);
    expect(textOf(res)).toContain("已基于底图生成图片");
    expect((res.details as { imageToImage?: boolean }).imageToImage).toBe(true);
  });

  test("4xx 被拒 → 回落 edits multipart；成图落盘报路径", async () => {
    stubFetch((req) =>
      req.url.endsWith("/images/edits")
        ? jsonResponse({ data: [{ b64_json: PNG_1x1 }] })
        : jsonResponse({ error: { message: "image param unsupported" } }, 400),
    );
    calls.length = 0;
    const res = await tool().execute(
      "i2",
      { prompt: "把背景改成夜景", image: "i2i-input.png" },
      undefined,
    );
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe("https://gw.test/v1/images/generations");
    expect(calls[1].url).toBe("https://gw.test/v1/images/edits");
    expect(calls[1].body).toBeInstanceOf(FormData);
    const form = calls[1].body as FormData;
    expect(form.get("prompt")).toBe("把背景改成夜景");
    expect((form.get("image") as File).name).toBe("input.png");
    expect(textOf(res)).toContain("已基于底图生成图片");
    const saved = (res.details as { paths?: string[] }).paths?.[0] ?? "";
    expect(saved).toContain(path.join(".kova", "imagegen"));
    expect(existsSync(saved)).toBe(true);
    expect(textOf(res)).toContain(saved);
  });

  test("两种形态均被拒：文案带状态与「两种形态」说明", async () => {
    stubFetch(() => jsonResponse({ error: { message: "bad model" } }, 400));
    calls.length = 0;
    const res = await tool().execute("i3", { prompt: "x", image: "i2i-input.png" }, undefined);
    expect(calls.length).toBe(2);
    expect(textOf(res)).toContain("HTTP 400");
    expect(textOf(res)).toContain("两种形态均被拒绝");
  });

  test("底图缺文件：错误文本透出不发请求", async () => {
    stubFetch(() => jsonResponse({ data: [{ b64_json: PNG_1x1 }] }));
    calls.length = 0;
    const res = await tool().execute("i4", { prompt: "x", image: "nope.png" }, undefined);
    expect(calls.length).toBe(0);
    expect(textOf(res)).toContain("底图读取失败");
  });
});
