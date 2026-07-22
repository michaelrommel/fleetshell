#!/bin/sh
/usr/sbin/sshd
exec /usr/local/bin/test-server
