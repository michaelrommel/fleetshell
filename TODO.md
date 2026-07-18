
# What's missing and to be implemented between Monday and Wednesday.

## Set up a webserver in AWS acting as nucleus portal stub

- static login with username/password
- LE certificate for portal.fleetshell.com
- Website with a form, where the details of a machine can be entered, like it came from MDM
- Buttons for all supported services, RDP, VNC, HTTP, HTTPS
- ability to create signed JWTs
- ability to retrieve Lets Encrypt (LE) certificates
- ability to perform LE auth challenges (web based)
- portal website must be able to send requests to the locally running fleetshell-client and submit the connect request

## fleetshell-client
- needs a proper official certificate
- client will get an enrollement page
- enrollment connects to the portal, where user logs in
- client requests a uniqe name
- client creates a pub/private key pair
- client creates a CSR for *.<uniqename>.client.fleetshell.com
- sends CSR to the portal
- portal gets the signed cert from LE, sends it to client
- client switches on https listener
- if CSR dance is too cumbersome in that short time, we can switch to one shared cert for starters (*.client.fleetshell.com)
- Client needs to prepare 16 slots for connections: 127.0.0.2-127.0.0.17
- Each slot needs to be displayed with a free/busy-until timer
- settings page needs an idle time field: after that many seconds of no traffic, the connection listener is shut down. Ideally different settings for different protocols. (long for http/s, short for rdp/vnc)

## fleetshell-gateway
- container image needed for it
- NLB or ALB needs to be set up
- if ALB terminates HTTPS, we need a certificate for connect.fleetshell.com

## Simulated devices
- We need some virtual machines or similar in the same AWS VPC
- Windows possibly with servers for VNC, RDP, HTTP or HTTPS (self-signed certs sufficient, same as on medical devices)

