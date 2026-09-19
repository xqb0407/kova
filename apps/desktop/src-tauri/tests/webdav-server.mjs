// 备份功能测试用的最小 WebDAV 服务器（零依赖）：
// 支持 OPTIONS / PROPFIND / MKCOL / PUT / GET / DELETE + Basic 认证，
// 其余方法返回 405。启动后向 stdout 打印监听端口（cargo 测试读取）。
import http from "node:http";

const PORT = Number(process.env.PORT || 0);
const USER = process.env.DAV_USER || "user";
const PASS = process.env.DAV_PASS || "pass";

/** path -> "dir" | Buffer；种子目录 /dav/ */
const store = new Map();
store.set("/dav/", "dir");

const checkAuth = (req) =>
  (req.headers.authorization || "") ===
  `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;

const multistatus = (entries) =>
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${entries
    .map(
      ([href, isDir, size, modified]) =>
        `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${
          isDir
            ? "<D:resourcetype><D:collection/></D:resourcetype>"
            : `<D:resourcetype/><D:getcontentlength>${size}</D:getcontentlength>`
        }<D:getlastmodified>${modified}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    )
    .join("")}</D:multistatus>`;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (!checkAuth(req)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="t"' });
      return res.end();
    }
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const value = store.get(path);
    const isDir = value === "dir";
    switch (req.method) {
      case "OPTIONS":
        res.writeHead(200, {
          Allow: "OPTIONS, GET, PUT, DELETE, PROPFIND, MKCOL",
        });
        return res.end();
      case "PROPFIND": {
        if (!isDir && value === undefined) {
          res.writeHead(404);
          return res.end();
        }
        const entries = [[path, isDir, 0, "Mon, 01 Sep 2026 00:00:00 GMT"]];
        if ((req.headers.depth || "0") === "1") {
          const prefix = path.endsWith("/") ? path : `${path}/`;
          for (const [p, kind] of store) {
            if (p !== path && p.startsWith(prefix)) {
              const dir = kind === "dir";
              entries.push([
                p,
                dir,
                dir ? 0 : kind.length,
                "Mon, 01 Sep 2026 00:00:00 GMT",
              ]);
            }
          }
        }
        res.writeHead(207, { "Content-Type": "application/xml" });
        return res.end(multistatus(entries));
      }
      case "MKCOL": {
        if (value !== undefined) {
          res.writeHead(405);
          return res.end();
        }
        const dir = path.endsWith("/") ? path : `${path}/`;
        const parent = dir.replace(/\/[^/]*\/$/, "/");
        if (parent !== "/" && !store.has(parent) && parent !== dir) {
          res.writeHead(409);
          return res.end();
        }
        store.set(dir, "dir");
        res.writeHead(201);
        return res.end();
      }
      case "PUT": {
        if (isDir || path.endsWith("/")) {
          res.writeHead(405);
          return res.end();
        }
        store.set(path, body);
        res.writeHead(201);
        return res.end();
      }
      case "GET": {
        if (isDir || value === undefined) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { "Content-Length": value.length });
        return res.end(value);
      }
      case "DELETE": {
        if (value === undefined) {
          res.writeHead(404);
          return res.end();
        }
        const prefix = path.endsWith("/") ? path : `${path}/`;
        for (const p of [...store.keys()]) {
          if (p === path || p.startsWith(prefix)) store.delete(p);
        }
        res.writeHead(204);
        return res.end();
      }
      default:
        res.writeHead(405, {
          Allow: "OPTIONS, GET, PUT, DELETE, PROPFIND, MKCOL",
        });
        return res.end("method not allowed");
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(server.address().port);
});
