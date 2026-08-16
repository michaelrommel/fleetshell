/**
 * FleetShell client API constants (portal-side).
 *
 * The port is runtime-configurable via the PUBLIC_CLIENT_API_PORT environment
 * variable so operators can adjust it per deployment without rebuilding the
 * portal image. SvelteKit exposes PUBLIC_* variables to both SSR and browser
 * code via $env/dynamic/public, so the value is always current at runtime.
 */
import { env } from '$env/dynamic/public';

/** Port the FleetShell Windows client API listens on. */
export const CLIENT_API_PORT: string = env.PUBLIC_CLIENT_API_PORT ?? '58596';

/** DNS hostname resolving to 127.0.0.1, covered by *.client.fleetshell.com. */
export const CLIENT_API_HOST = '127-0-0-1.client.fleetshell.com';

/** HTTPS base URL for the local FleetShell client API. */
export const CLIENT_API_BASE = `https://${CLIENT_API_HOST}:${CLIENT_API_PORT}`;
