/**
 * 二进制资源模块声明：设计主题包 zip 以 `import url from "./x.zip" with { type: "file" }`
 * 引入——dev 运行给出磁盘路径，`bun build --compile` 把文件嵌进单文件二进制并给出
 * $bunfs 虚拟路径，两种形态都能被 Bun.file() 读取。
 */
declare module "*.zip" {
  const url: string;
  export default url;
}

/**
 * WebAssembly 资源（Photon 图片处理器）：`import url from "…wasm" with
 * { type: "file" }` 的解析结果同 zip——dev 下是磁盘路径，编译后是 $bunfs
 * 虚拟路径，两种形态都能被 readFileSync 读取。
 */
declare module "*.wasm" {
  const url: string;
  export default url;
}
