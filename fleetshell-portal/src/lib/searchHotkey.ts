// Svelte action: pressing `/` focuses (and selects) the target search input,
// UNLESS the user is already typing in a field or on another focusable UI
// element. Lets keyboard users jump to the page search from anywhere.
//
//   <input use:searchHotkey placeholder="Search…" />
//
// The listener is bound to the target's ownerDocument and torn down on destroy,
// so it is safe across tab switches / SPA navigation (mount = active).

function isTypingTarget(el: EventTarget | null): boolean {
	if (!(el instanceof HTMLElement)) return false;
	const tag = el.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
		|| tag === 'BUTTON' || tag === 'A' || el.isContentEditable;
}

export function searchHotkey(node: HTMLInputElement) {
	function onKeydown(e: KeyboardEvent) {
		if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey
			&& !isTypingTarget(node.ownerDocument.activeElement)) {
			e.preventDefault();
			node.focus();
			node.select();
		}
	}
	window.addEventListener('keydown', onKeydown);
	return { destroy() { window.removeEventListener('keydown', onKeydown); } };
}
