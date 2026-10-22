// `npm run bundle-monaco` and `npm run build-mermaid` write these.
declare module "*.txt" {
  const text: string;
  export default text;
}
