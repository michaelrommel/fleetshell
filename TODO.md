
# What's missing and to be implemented between Monday and Wednesday.

## Set up a webserver in AWS acting as nucleus portal stub

- [x] static login with username/password
- [ ] LE certificate for portal.fleetshell.com
- [ ] Website with a form, where the details of a machine can be entered, like it came from MDM
- [ ] Buttons for all supported services, RDP, VNC, HTTP, HTTPS
- [x] ability to create signed JWTs
- [ ] ability to retrieve Lets Encrypt (LE) certificates
- [ ] ability to perform LE auth challenges (web based)
- [ ] portal website must be able to send requests to the locally running fleetshell-client and submit the connect request
- [x] portal can open custom protocol handler urls fleetshell:// and submit parameters
- [x] portal generates and persists client ids in redis per user
- [x] can open a probe request and authenticate and validate incoming probes
- [x] portal be can inform the portal via SSE about incoming valid probes
- [x] portal can display probe results
- [x] convert client test page to enrollment page with more space and guided steps

## fleetshell-client
- [ ] Phase 1: client needs to persist the unique id given by the probe/enrollment request
- [ ] Phase 1: get one shared cert for starters (*.client.fleetshell.com)
- [ ] Phase 1: client submits a simplified certificate request to the portal for its id
- [ ] Phase 2: client creates a pub/private key pair
- [ ] Phase 2: client creates a CSR for *.<uniqename>.client.fleetshell.com
- [ ] Phase 2: sends CSR to the portal
- [ ] Phase 1: portal gets the signed cert from LE, sends it to client
- [ ] Phase 1: client switches on https listener
- [ ] Client needs to prepare 16 slots for connections: 127.0.0.2-127.0.0.17
- [ ] Each slot needs to be displayed with a free/busy-until timer
- [ ] settings page needs an idle time field: after that many seconds of no traffic, the connection listener is shut down. Ideally different settings for different protocols. (long for http/s, short for rdp/vnc)
- [x] registers protocol handler on start
- [x] NSIS installer for user-based installs
- [x] single instance support
- [x] parses custom scheme payload, initiates client probes to portal
- [x] portal base url configurable and persisting

## fleetshell-gateway
- [ ] container image needed for it
- [ ] NLB or ALB needs to be set up
- [ ] if ALB terminates HTTPS, we need a certificate for connect.fleetshell.com
- [ ] transform mode is wired to `NoopHook`; implement concrete `TransformHook`
   impls as needed (e.g. rewrite `Host:` header, inject auth headers, redact
   sensitive fields in responses)
- [ ] transform mode is HTTP/1.1 only; add HTTP/2 support if upstream devices
   require it
- [ ] `GATEWAY_UPSTREAM_TLS_ACCEPT_INVALID_CERTS` defaults to `true`; add a
   proper upstream trust store (e.g. `webpki-roots`) for CA-signed deployments
- [ ] body buffering in transform mode has a 16 MiB limit; add streaming support
   for large file transfers if required

## Simulated devices
- We need some virtual machines or similar in the same AWS VPC
- Windows possibly with servers for VNC, RDP, HTTP or HTTPS (self-signed certs sufficient, same as on medical devices)

