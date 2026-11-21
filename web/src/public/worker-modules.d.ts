// The Gateway bundles the public pages with Wrangler, which loads these bytes as data.
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
