declare module 'fontfaceobserver' {
	export default class FontFaceObserver {
		constructor(family: string, descriptors?: {
			weight?: string | number;
			style?:  string;
			stretch?: string;
		});
		load(text?: string | null, timeout?: number): Promise<void>;
	}
}
