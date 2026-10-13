// CSS files are bundled as strings (rspack asset/source) and injected by the code.
declare module "*.css" {
	const source: string;
	export default source;
}
