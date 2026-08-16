// Lightweight global toast notifications.
//
// A shared runes store (like viewLayout) holds the active toasts; <Toast /> is
// mounted once in AppShell and renders them. `toastEnhance` wraps a form's
// use:enhance so a successful save (including the common redirect-on-success
// pattern) pops a success toast, and a validation failure pops an error toast.

import { applyAction } from '$app/forms';
import type { SubmitFunction } from '@sveltejs/kit';

export type ToastKind = 'success' | 'error';
export interface Toast {
	id: number;
	message: string;
	kind: ToastKind;
}

export const toasts = $state<Toast[]>([]);
let seq = 0;

export function showToast(message: string, kind: ToastKind = 'success', ttl = 3200): void {
	const id = ++seq;
	toasts.push({ id, message, kind });
	if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: number): void {
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1);
}

/**
 * use:enhance helper: show `successMsg` on success (server actions here throw a
 * 303 redirect on success, so that is the primary path), and surface the
 * action's `error` payload as an error toast on failure. `onSettle` runs at the
 * end regardless (e.g. to close a confirm dialog).
 */
export function toastEnhance(successMsg: string, onSettle?: () => void): SubmitFunction {
	return () =>
		async ({ result, update }) => {
			try {
				if (result.type === 'redirect') {
					showToast(successMsg, 'success');
					await applyAction(result);
				} else if (result.type === 'failure') {
					await update();
					const err = (result.data as Record<string, unknown> | undefined)?.error;
					showToast(String(err ?? 'Action failed'), 'error');
				} else if (result.type === 'error') {
					await applyAction(result);
					showToast('Something went wrong', 'error');
				} else {
					await update();
					showToast(successMsg, 'success');
				}
			} finally {
				onSettle?.();
			}
		};
}
