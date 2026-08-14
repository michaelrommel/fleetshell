// src/lib/nav.ts  (shared, client + server safe)
//
// Single source of truth for the left sidebar. The AppShell renders these in
// two groups (primary / utility) separated by a spacer, matching the
// icon-rail look of theme-reference/nucleus_transfer_history.png.
//
// `icon` is a key into the inline SVG set in AppShell.svelte (keeps the icon
// markup in one place and this list serialisable). `href` is base-relative.

export type NavIcon =
	| 'devices'
	| 'gateways'
	| 'products'
	| 'customers'
	| 'services'
	| 'administration'
	| 'support'
	| 'settings';

export interface NavItem {
	/** Base-relative path, e.g. '/devices'. */
	href: string;
	/** Icon key resolved in AppShell.svelte. */
	icon: NavIcon;
	/** Label; may contain a '/' that is allowed to wrap onto two lines. */
	label: string;
	/** Interim gate: greyed out unless the active persona is_admin. */
	requiresAdmin?: boolean;
}

/** Primary sections (top of the rail). */
export const PRIMARY_NAV: NavItem[] = [
	{ href: '/devices',        icon: 'devices',        label: 'Devices' },
	{ href: '/gateways',       icon: 'gateways',       label: 'Gateways' },
	{ href: '/customers',      icon: 'customers',      label: 'Customers\nSites' },
	{ href: '/products',       icon: 'products',       label: 'Products' },
	{ href: '/services',       icon: 'services',       label: 'Services' },
	{ href: '/administration', icon: 'administration', label: 'Admin', requiresAdmin: true },
];

/** Utility sections (pinned to the bottom of the rail). */
export const UTILITY_NAV: NavItem[] = [
	{ href: '/support',  icon: 'support',  label: 'Support' },
	{ href: '/settings', icon: 'settings', label: 'Settings' },
];
