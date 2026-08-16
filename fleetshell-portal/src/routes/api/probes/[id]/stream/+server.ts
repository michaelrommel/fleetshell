/**
 * GET /api/probes/[id]/stream
 *
 * SSE stream. The browser opens this after receiving the probe ID; when the
 * desktop client POSTs its version data, Redis pub/sub delivers it here and we
 * forward it as an SSE "result" event.
 *
 * Ownership is checked against the login account's association. The subscriber
 * connection uses subscriberOptions() (TLS-preserving + no auto-reconnect).
 */
import { error } from '@sveltejs/kit';
import { getRedisClient, subscriberOptions } from '$lib/server/redis';
import type { RequestHandler } from './$types';

const STREAM_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS = 15_000;

export const GET: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.accountId) error(401, 'Unauthorized');

	const { id } = params;
	const redis = await getRedisClient();
	const ownerId = await redis.get(`association:${locals.accountId}`);
	if (ownerId !== id) error(403, 'Forbidden');

	const encoder = new TextEncoder();

	let subscriber: ReturnType<typeof redis.duplicate> | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let timeout: ReturnType<typeof setTimeout> | null = null;
	let closed = false;
	let resultReceived = false;
	let _controller: ReadableStreamDefaultController<Uint8Array> | null = null;

	const send = (event: string, data: unknown) => {
		if (closed || !_controller) return;
		try {
			_controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
		} catch {
			closed = true;
		}
	};

	const closeStream = () => {
		if (closed || !_controller) return;
		closed = true;
		try {
			_controller.close();
		} catch {
			/* already closed */
		}
	};

	const cleanup = async () => {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		if (timeout) {
			clearTimeout(timeout);
			timeout = null;
		}
		if (subscriber) {
			const sub = subscriber;
			subscriber = null;
			try {
				await sub.unsubscribe();
			} catch {
				/* ignore */
			}
			try {
				sub.disconnect();
			} catch {
				/* ignore */
			}
		}
	};

	request.signal.addEventListener('abort', async () => {
		await cleanup();
		closeStream();
	});

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			_controller = controller;

			// Fast path: result already in Redis (client responded before SSE opened).
			const existing = await redis.get(`client:${id}:probe`);
			if (existing && existing !== 'pending') {
				send('result', JSON.parse(existing));
				closeStream();
				return;
			}

			subscriber = redis.duplicate(subscriberOptions());
			await subscriber.connect();

			await subscriber.subscribe(`probe:${id}`, async (message) => {
				if (resultReceived) return;
				resultReceived = true;
				let parsed: unknown;
				try {
					parsed = JSON.parse(message);
				} catch {
					parsed = { raw: message };
				}
				await cleanup();
				send('result', parsed);
				closeStream();
			});

			send('ready', { id });

			heartbeat = setInterval(() => {
				if (closed) {
					clearInterval(heartbeat!);
					heartbeat = null;
					return;
				}
				try {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
				} catch {
					clearInterval(heartbeat!);
					heartbeat = null;
				}
			}, HEARTBEAT_MS);

			timeout = setTimeout(async () => {
				await cleanup();
				send('timeout', { id });
				closeStream();
			}, STREAM_TIMEOUT_MS);
		},

		async cancel() {
			await cleanup();
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
};
