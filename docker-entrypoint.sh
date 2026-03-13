#!/bin/sh
# Fix ownership of mounted volumes (Railway mounts as root)
chown -R node:node /app/data 2>/dev/null || true
exec su-exec node "$@"
