/**
 * GET /api/enrollment/[id]/stream
 *
 * SSE stream for the enrollment flow. Opened by the browser after the probe
 * result; stays open until the client confirms cert receipt or it times out.
 *
 * Events: ready, csr-received, cert-ready, enrollment-confirmed, timeout.
 * Fast-path replay reads current Redis state after subscribing so a reconnect
 * catches up on already-passed events. Ownership via the account association.
 */
import { error } from '@sveltejs/kit';
import { getRedisClient, subscriberOptions } from '$lib/server/redis';
import type { RequestHandler } from './$types';

const STREAM_TIMEOUT_MS = 5 * 60_000;
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
	let _controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const sentEvents = new Set<string>();

	const send = (event: string, data: unknown) => {
		if (closed || !_controller) return;
		try {
			_controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
		} catch {
			closed = true;
		}
	};
	const sendOnce = (event: string, data: unknown) => {
		if (sentEvents.has(event)) return;
		sentEvents.add(event);
		send(event, data);
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

			// Subscribe FIRST, then read state, to avoid a TOCTOU gap.
			subscriber = redis.duplicate(subscriberOptions());
			await subscriber.connect();

			await subscriber.subscribe(`enrollment:${id}`, async (message) => {
				let parsed: { event: string; [k: string]: unknown };
				try {
					parsed = JSON.parse(message) as typeof parsed;
				} catch {
					return;
				}
				sendOnce(parsed.event, parsed);
				if (parsed.event === 'enrollment-confirmed') {
					await cleanup();
					closeStream();
				}
			});

			// Fast-path replay from current Redis state.
			const [certStatus, confirmed] = await Promise.all([
				redis.get(`client:${id}:cert`),
				redis.get(`client:${id}:enrollment:confirmed`),
			]);

			if (confirmed === '1') {
				const csr = await redis.get(`client:${id}:cert:csr`);
				sendOnce('csr-received', { event: 'csr-received', csr: csr ?? '' });
				sendOnce('cert-ready', { event: 'cert-ready' });
				sendOnce('enrollment-confirmed', { event: 'enrollment-confirmed' });
				await cleanup();
				closeStream();
				return;
			}
			if (certStatus === 'ready') {
				const csr = await redis.get(`client:${id}:cert:csr`);
				sendOnce('csr-received', { event: 'csr-received', csr: csr ?? '' });
				sendOnce('cert-ready', { event: 'cert-ready' });
			} else if (certStatus === 'pending') {
				const csr = await redis.get(`client:${id}:cert:csr`);
				sendOnce('csr-received', { event: 'csr-received', csr: csr ?? '' });
			}

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
