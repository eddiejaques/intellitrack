declare module "*.md" {
  const text: string;
  export default text;
}

/** injected by esbuild `define`; identical in every bundle of one build */
declare const __BUILD_ID__: string;
