#!/usr/bin/env bash

cookievalue=$1
cookie="fleetshell_session=$cookievalue"
body='{"target":"172.16.28.109","ports":"3389","gateway":"gateway.fleetshell.com"}'

curl -s -X POST https://portal.fleetshell.com/api/tunnel/sign \
  -H "Content-Type: application/json" \
  -H "Cookie: $cookie" \
  -d "$body"
