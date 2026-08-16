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
			/** Open a new clipboard stream to send local clipboard content to the remote. */
			createClipboardStream(mimetype: string): unknown;
			onstatechange:  ((state: number) => void)                       | null;
			onerror:        ((status: { code?: number; message?: string }) => void) | null;
			onaudio:        ((stream: unknown, mimetype: string) => void)   | null;
			/** Fired when the remote sends clipboard data to the client. */
			onclipboard:    ((stream: unknown, mimetype: string) => void)   | null;
		}

		class Display {
			getElement(): HTMLElement;
			/** Scale the display by the given factor, adjusting mouse coordinate mapping. */
			scale(scale: number): void;
			/** Current rendered width of the remote desktop in pixels (pre-scale). */
			getWidth(): number;
			/** Current rendered height of the remote desktop in pixels (pre-scale). */
			getHeight(): number;
			/**
			 * Fired whenever the remote desktop changes size (first `size` instruction
			 * after connect, and on any subsequent resize).
			 */
			onresize: ((width: number, height: number) => void) | null;
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
			static getInstance(stream: unknown, mimetype: string): AudioPlayer | null;
		}

		/**
		 * Writes text to a Guacamole stream (e.g. the clipboard stream returned
		 * by `client.createClipboardStream()`).
		 */
		class StringWriter {
			constructor(stream: unknown);
			sendText(text: string): void;
			sendEnd(): void;
		}

		/**
		 * Reads text from a Guacamole stream (e.g. the clipboard stream passed
		 * to `client.onclipboard`).
		 */
		class StringReader {
			constructor(stream: unknown);
			ontext: ((text: string) => void) | null;
			onend:  (() => void)             | null;
		}

		namespace Status {
			const Code: { UNSUPPORTED: number; [key: string]: number };
		}
	}
	export = Guacamole;
}
