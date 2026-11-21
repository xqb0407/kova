import { describe, expect, test } from "bun:test";
import { parseCurlCommand } from "./curl-import";

describe("parseCurlCommand", () => {
  test("POST + JSON body + 多个 header(单引号)", () => {
    const parsed = parseCurlCommand(
      `curl -s -X POST 'https://api.example.com/search' -H 'Content-Type: application/json' -H 'Authorization: Bearer tok-1' -d '{"query":"electron"}'`,
    );
    expect(parsed?.method).toBe("POST");
    expect(parsed?.url).toBe("https://api.example.com/search");
    expect(parsed?.headers["Content-Type"]).toBe("application/json");
    expect(parsed?.headers["Authorization"]).toBe("Bearer tok-1");
    expect(parsed?.body).toBe('{"query":"electron"}');
  });

  test("双引号 body:单引号包裹时空格保留", () => {
    const parsed = parseCurlCommand(
      `curl -X POST https://api.example.com/s -H 'Content-Type: application/json' --data-raw '{"q":"hello world","n":3}'`,
    );
    expect(parsed?.method).toBe("POST");
    expect(parsed?.body).toBe('{"q":"hello world","n":3}');
  });

  test("双引号内的 \\\" 转义成引号", () => {
    const parsed = parseCurlCommand(
      'curl -X POST https://api.example.com/s --data-raw "say \\"hi\\""',
    );
    expect(parsed?.body).toBe('say "hi"');
  });

  test("无 -X 且带 -d:默认 POST;裸 URL;User-Agent/Referer 映射为头", () => {
    const parsed = parseCurlCommand(
      `curl https://api.example.com/s -A "MyAgent/1.0" -e "https://ref.example" --data-raw "q=test" --compressed`,
    );
    expect(parsed?.method).toBe("POST");
    expect(parsed?.url).toBe("https://api.example.com/s");
    expect(parsed?.headers["User-Agent"]).toBe("MyAgent/1.0");
    expect(parsed?.headers["Referer"]).toBe("https://ref.example");
    expect(parsed?.body).toBe("q=test");
  });

  test("GET:-X GET 且无 body", () => {
    const parsed = parseCurlCommand(
      `curl -X GET "https://api.example.com/s?q=test" -H "Accept: application/json"`,
    );
    expect(parsed?.method).toBe("GET");
    expect(parsed?.url).toBe("https://api.example.com/s?q=test");
    expect(parsed?.headers["Accept"]).toBe("application/json");
    expect(parsed?.body).toBeUndefined();
  });

  test("多个 -d 用 & 连接(curl 语义)", () => {
    const parsed = parseCurlCommand(
      `curl -X POST https://api.example.com/s -d "a=1" -d "b=2"`,
    );
    expect(parsed?.body).toBe("a=1&b=2");
  });

  test("PUT 不映射(表单保持当前值);非 http URL 返回 null", () => {
    expect(parseCurlCommand(`curl -X PUT https://api.example.com`)?.method).toBeUndefined();
    expect(parseCurlCommand(`curl ftp://example.com/file`)).toBeNull();
    expect(parseCurlCommand(`not a curl command`)).toBeNull();
    expect(parseCurlCommand(`curl -s --compressed`)).toBeNull(); // 无 URL
  });
});
