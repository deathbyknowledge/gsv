// Wrangler bundles these by its default rules: WebAssembly compiled when the Worker is uploaded, and other bytes as data.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
