#!/bin/sh

# If config.json does not exist locally and CONFIG environment variable is set, dump its JSON content into config.json
if [ ! -f config.json ]; then
  if [ -n "$CONFIG" ]; then
    echo "[Start] No local config.json found and CONFIG env detected, writing to config.json..."
    echo "$CONFIG" > config.json
  else
    echo "[Start] No local config.json found and CONFIG env is not set. Service might start with defaults."
  fi
else
  echo "[Start] Existing config.json found locally. Skipping CONFIG env parsing."
fi

# If keys.json does not exist locally and KEYS environment variable is set, dump its content
if [ ! -f keys.json ]; then
  if [ -n "$KEYS" ]; then
    echo "[Start] No local keys.json found and KEYS env detected, writing to keys.json..."
    echo "$KEYS" > keys.json
  else
    echo "[Start] No local keys.json found and KEYS env is not set. Service might start with empty key pool."
  fi
else
  echo "[Start] Existing keys.json found locally. Skipping KEYS env parsing."
fi

# Run the proxy server
exec node index.js
