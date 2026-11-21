/**
 * Bun resolves a `.wasm` import to a filesystem path string. Inside a compiled
 * binary the path points at the embedded copy; the dev runtime points at the
 * installed `quickjs-wasi` package.
 */
declare module "quickjs-wasi/quickjs.wasm" {
  const path: string;
  export default path;
}
