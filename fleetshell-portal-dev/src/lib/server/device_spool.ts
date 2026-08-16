// src/lib/server/device_spool.ts
//
// Device Valkey spooler. The portal is now the system of record for devices, so
// it writes the whole per-device hash that aeroftp consumes (opaque S3 metadata,
// plus the four fields aeroftp keys off: modality, product, partno, serial):
//
//   HASH  systems:by-ip:<device.ip_address>
//
// aeroftp reads this at FTP login (HGETALL systems:by-ip:<client_ip>) and also
// builds the data_classes:<MODALITY>:<PRODUCT> lookup from `modality`+`product`,
// so those two MUST be the product-tree node names (same strings the
// classification spool writes). See docs/valkey_spool.md.
//
// Spooling is WRITE-THROUGH on device save (not a bulk export): on save we
// rewrite this device's key AND re-spool its IPsec gateway (the device is part of
// that gateway's fleetipsec:nat device_nat[]). Keys therefore exist only for
// devices actually touched.

import { getRedisClient } from '$lib/server/redis';
import { globalDb } from '$lib/server/db';
import { spoolGateway } from '$lib/server/gateway_spool';

export const SYS_PREFIX = 'systems:by-ip:';

type DeviceSpoolRow = {
	ip: string | null;
	gateway_id: string | null;
	serial: string | null;
	country_iso: string | null;
	internal_use: string | null;
	dpa: boolean;
	dmy: boolean;
	dtm: string;
	partno: string | null;
	modality: string | null;
	product: string | null;
};

/** Assemble the systems:by-ip hash fields from a device row (empties dropped). */
export function buildDeviceHash(r: DeviceSpoolRow): Record<string, string> {
	// contracts: [STD|NIU], DPA, DMY -> comma-joined (e.g. "STD,DPA").
	const contracts: string[] = [];
	if (r.internal_use) contracts.push(r.internal_use);
	if (r.dpa) contracts.push('DPA');
	if (r.dmy) contracts.push('DMY');

	const hash: Record<string, string> = {};
	const put = (k: string, v: string | null | undefined) => {
		if (v != null && v !== '') hash[k] = v;
	};
	put('modality', r.modality);
	put('product', r.product);
	put('partno', r.partno);
	put('serial', r.serial);
	put('country', r.country_iso);
	put('dtm', r.dtm || 'STD');
	if (contracts.length) hash.contracts = contracts.join(',');
	return hash;
}

async function loadDeviceRow(deviceId: string): Promise<DeviceSpoolRow | null> {
	const [row] = await globalDb<DeviceSpoolRow[]>`
		SELECT d.ip_address AS ip, d.gateway_id::text AS gateway_id,
		       d.serial, d.country_iso, d.internal_use, d.dpa, d.dmy,
		       COALESCE(cu.dtm_variant, 'STD') AS dtm,
		       pm.partno::text AS partno,
		       -- Same expressions the device page uses: the product tree has a root
		       -- node at position 0, so modality = level-2 (subltree 0,2) and product =
		       -- the model's direct parent. Both are path-equality (exactly one row) and
		       -- match the data_classes:<MODALITY>:<PRODUCT> naming.
		       (SELECT md.name FROM product md WHERE md.path = subltree(d.product_path, 0, 2)) AS modality,
		       (SELECT pr.name FROM product pr WHERE pr.path = subpath(d.product_path, 0, nlevel(d.product_path) - 1)) AS product
		FROM device d
		LEFT JOIN product m        ON m.path = d.product_path
		LEFT JOIN product_model pm ON pm.product_id = m.id
		LEFT JOIN customer cu      ON cu.id = d.customer_id
		WHERE d.id = ${deviceId}`;
	return row ?? null;
}

/** Delete a stale systems:by-ip key (e.g. after an IP change or device delete). */
export async function deleteDeviceKey(ip: string): Promise<void> {
	if (!ip) return;
	const redis = await getRedisClient();
	await redis.unlink(`${SYS_PREFIX}${ip}`);
}

/**
 * Spool one device's systems:by-ip hash. The portal fully owns this key, so it is
 * rewritten from scratch (DEL + HSET). Returns { ip, gatewayId } for follow-up
 * gateway spooling; ip is null when the device has no IP (nothing written).
 */
export async function spoolDevice(deviceId: string): Promise<{ ip: string | null; gatewayId: string | null }> {
	const row = await loadDeviceRow(deviceId);
	if (!row) return { ip: null, gatewayId: null };
	if (!row.ip) return { ip: null, gatewayId: row.gateway_id };

	const redis = await getRedisClient();
	const key = `${SYS_PREFIX}${row.ip}`;
	const hash = buildDeviceHash(row);
	await redis.del(key);
	if (Object.keys(hash).length) await redis.hSet(key, hash);
	return { ip: row.ip, gatewayId: row.gateway_id };
}

/**
 * Write-through on device save: rewrite this device's key, drop the stale key on
 * an IP change, and re-spool the affected gateway(s) (current + previous when the
 * device moved between gateways).
 */
export async function spoolDeviceOnSave(
	deviceId: string,
	prev?: { ip: string | null; gatewayId: string | null },
): Promise<void> {
	const cur = await spoolDevice(deviceId);
	if (prev?.ip && prev.ip !== cur.ip) await deleteDeviceKey(prev.ip);

	const gateways = new Set<string>();
	if (cur.gatewayId) gateways.add(cur.gatewayId);
	if (prev?.gatewayId) gateways.add(prev.gatewayId);
	for (const g of gateways) await spoolGateway(g);
}
