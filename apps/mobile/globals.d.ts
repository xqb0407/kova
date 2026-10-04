declare module "*.css";

// 品牌图（吉祥物 icon 等）经 require 引入，Metro 解析为资源 id。
declare module "*.png" {
  const value: number;
  export default value;
}
