/** A .woff2 file, which the build bundles as a data URL (see the build script and the test page bundle). */
declare module "*.woff2" {
  const url: string;
  export default url;
}
