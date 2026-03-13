#!/bin/sh
# Fix ownership of mounted volumes (Railway mounts as root)
# Only chown if the directory is not already owned by node
if [ "$(stat -c '%u' /app/data 2>/dev/null)" != "1000" ]; then
  chown -R node:node /app/data 2>/dev/null || true
fi
exec su-exec node "$@"
