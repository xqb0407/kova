import { describe, expect, it } from "vitest";
import { decodePairPayload, type PairPayload } from "./pair-payload";

/**
 * 用桌面端 encodePairPayload 的同款算法造样本（lib/remote.ts:56-62）——
 * 这里断言的是「移动端能不能吃下桌面端真实吐出来的二维码」，
 * 所以不能自己发明一种编码来测自己。
 */
function encodePairPayload(payload: PairPayload): string {
  const json = JSON.stringify(payload);
  let bin = "";
  for (const b of new TextEncoder().encode(json)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const DATA: PairPayload = { v: 1, host: "ws://192.168.1.5:8787/ws", code: "483920" };
const ENCODED = encodePairPayload(DATA);

describe("decodePairPayload", () => {
  it("桌面端默认二维码：扫码直达链接里的 #h=", () => {
    expect(decodePairPayload(`http://192.168.1.5:8787/#h=${ENCODED}`)).toEqual(DATA);
  });

  it("同一链接用 ?h= 或带尾随参数也能解", () => {
    expect(decodePairPayload(`http://10.0.0.5:8787/?h=${ENCODED}`)).toEqual(DATA);
    expect(decodePairPayload(`https://a.example/#h=${ENCODED}&x=1`)).toEqual(DATA);
  });

  it("deep link pikova://pair#h=", () => {
    expect(decodePairPayload(`pikova://pair#h=${ENCODED}`)).toEqual(DATA);
  });

  it("降级形态：裸 JSON（桌面端无局域网 http 预览地址时）", () => {
    expect(decodePairPayload(JSON.stringify(DATA))).toEqual(DATA);
  });

  it("纯 base64url 与 host|code 明文（旧链接、口述场景）", () => {
    expect(decodePairPayload(ENCODED)).toEqual(DATA);
    expect(decodePairPayload("ws://192.168.1.5:8787/ws|483920")).toEqual(DATA);
  });

  it("百分号转义的 h 参数", () => {
    expect(decodePairPayload(`http://10.0.0.5:8787/#h=${encodeURIComponent(ENCODED)}`)).toEqual(
      DATA,
    );
  });

  it("手输的裸地址必须解不出，否则地址框会被吞掉", () => {
    expect(decodePairPayload("ws://192.168.1.5:8787/ws")).toBeNull();
    expect(decodePairPayload("192.168.1.5:8787")).toBeNull();
  });

  it("脏数据与形状不符的载荷一律拒绝", () => {
    expect(decodePairPayload("")).toBeNull();
    expect(decodePairPayload("这不是二维码")).toBeNull();
    // 配对码必须 6 位：remote.rs generate_code 用 {n:06} 零填充
    expect(decodePairPayload(JSON.stringify({ ...DATA, code: "12345" }))).toBeNull();
    expect(decodePairPayload(JSON.stringify({ v: 2, host: DATA.host, code: DATA.code }))).toBeNull();
    expect(decodePairPayload(JSON.stringify({ host: DATA.host }))).toBeNull();
    // 链接里没有 h 参数（旧网页端首页链接）不该被当配对码
    expect(decodePairPayload("http://192.168.1.5:8787/")).toBeNull();
  });
});
