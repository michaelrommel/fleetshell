#!/usr/bin/env bash

cookievalue=$1
cookie="fleetshell_session=$cookievalue"
body='{"target":"192.168.13.187","ports":"5900","gateway":"127.0.0.1:8443"}'

curl -s -X POST https://portal.fleetshell.com/api/tunnel/sign \
  -H "Content-Type: application/json" \
  -H "Cookie: $cookie" \
  -d "$body"
