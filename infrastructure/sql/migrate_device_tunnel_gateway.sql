-- migrate_device_tunnel_gateway.sql  (GLOBAL plane: fleetshell)
--
-- Splits the two gateway notions on a device:
--   * gateway_id      -> the IPSec Gateway (RS-router / communication interface;
--                        the existing relation, unchanged).
--   * tunnel_gateway  -> the Tunnel Gateway NAME encoded in the connection JWT
--                        (the gw claim) and sent to the fleetshell-client. Free
--                        text for now; a proper relation can replace it later.
--
-- Apply on the global cluster; idempotent.

ALTER TABLE device ADD COLUMN IF NOT EXISTS tunnel_gateway text;
