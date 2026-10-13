// The parts of the Spicetify global this project uses. Player data and URIs
// stay loose: Spotify reshapes them between versions and the code guards at
// runtime.
declare namespace Spicetify {
	const Player: {
		data: any;
		origin: unknown;
		addEventListener(type: string, cb: () => void): void;
		isPlaying(): boolean;
		getProgress(): number;
	};
	const Platform: { History?: { push(path: string): void } };
	const CosmosAsync: { get(url: string): Promise<any> };
	const URI: any;
	const Locale: { getLocale(): string } | undefined;
	const React: typeof import("react");
	const ReactDOM: typeof import("react-dom") & Partial<typeof import("react-dom/client")>;
	const ReactComponent: { TooltipWrapper?: import("react").ComponentType<any> } | undefined;
	function getAudioData(uri?: string): Promise<any>;
	function colorExtractor(uri: string): Promise<Record<string, string> | null>;
	function showNotification(text: string, isError?: boolean, msTimeout?: number): void;
	namespace Menu {
		class Item {
			constructor(name: string, isEnabled: boolean, onClick: () => void, icon?: string);
			register(): void;
		}
	}
}

interface Window {
	Spicetify?: typeof Spicetify;
	__playerfx?: import("../extension/index").PlayerFxApi;
	render?: () => unknown;
}
