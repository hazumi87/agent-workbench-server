// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task
// Vite `?inline` CSS imports return the stylesheet as a string. Declare the
// module shape so tsc --noEmit type-checks the kit cleanly.
declare module '*.css?inline' {
  const css: string;
  export default css;
}
declare module '*.css' {
  const css: string;
  export default css;
}
