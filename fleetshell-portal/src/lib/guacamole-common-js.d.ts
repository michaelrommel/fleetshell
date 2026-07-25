/**
 * Minimal type declaration for guacamole-common-js.
 * The package ships no TypeScript types; this file silences the
 * implicit-any error while keeping usage readable.
 * Refine as needed when more of the API surface is used.
 */
declare module 'guacamole-common-js' {
	namespace Guacamole {
		class WebSocketTunnel {
			constructor(url: string);
			onerror: ((status: { code?: number; message?: string }) => void) | null;
		}
		class Client {
			constructor(tunnel: WebSocketTunnel);
			getDisplay(): Display;
			connect(data?: string): void;
			disconnect(): void;
			sendKeyEvent(pressed: 0 | 1, keysym: number): void;
			sendMouseState(state: unknown, applyDisplayScale?: boolean): void;
			onstatechange: ((state: number) => void) | null;
			onerror: ((status: { code?: number; message?: string }) => void) | null;
			onaudio: ((stream: unknown, mimetype: string) => void) | null;
		}
		class Display {
			getElement(): HTMLElement;
			scale(scale: number): void;
		}
		class Mouse {
			constructor(element: HTMLElement);
			onmousedown: ((state: unknown) => void) | null;
			onmouseup:   ((state: unknown) => void) | null;
			onmousemove: ((state: unknown) => void) | null;
		}
		class Keyboard {
			constructor(element: Document | HTMLElement);
			onkeydown: ((keysym: number) => void) | null;
			onkeyup:   ((keysym: number) => void) | null;
		}
		class AudioPlayer {
			/** Returns a player for the stream+mimetype pair, or null if unsupported. */
			static getInstance(stream: unknown, mimetype: string): AudioPlayer | null;
		}
		namespace Status {
			const Code: { UNSUPPORTED: number; [key: string]: number };
		}
	}
	export = Guacamole;
}
