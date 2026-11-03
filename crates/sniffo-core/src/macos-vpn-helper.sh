#!/bin/sh
# Sniffo VPN proxy helper (macOS). Installed root-owned in /Library/PrivilegedHelperTools and
# allowed via sudoers for the installing user only. VPN clients (Cato, GlobalProtect, ...)
# publish their own proxy settings in the dynamic store, which override System Settings;
# this points that entry at Sniffo and puts the original back.
#   set <port>   point the primary service's proxies at 127.0.0.1:<port> (saves the original once)
#   restore      put the original entry back
set -eu
STATE=/var/db/dev.sniffo.vpn-proxy
SCUTIL=/usr/sbin/scutil

primary() { printf 'show State:/Network/Global/IPv4\n' | $SCUTIL | /usr/bin/awk '/PrimaryService/ {print $3}'; }

case "${1:-}" in
  set)
    PORT="${2:-}"
    case "$PORT" in ''|*[!0-9]*) echo "bad port" >&2; exit 2 ;; esac
    ID=$(primary)
    case "$ID" in ''|*[!A-Za-z0-9-]*) echo "no primary service" >&2; exit 3 ;; esac
    KEY="State:/Network/Service/$ID/Proxies"
    if [ ! -f "$STATE.key" ]; then
      printf 'show %s\n' "$KEY" | $SCUTIL > "$STATE.orig"
      echo "$KEY" > "$STATE.key"
    fi
    $SCUTIL <<SCUTIL
d.init
d.add FTPPassive # 1
d.add HTTPEnable # 1
d.add HTTPProxy 127.0.0.1
d.add HTTPPort # $PORT
d.add HTTPSEnable # 1
d.add HTTPSProxy 127.0.0.1
d.add HTTPSPort # $PORT
d.add ExceptionsList * localhost 127.0.0.1 *.local 169.254/16
set $KEY
SCUTIL
    ;;
  restore)
    [ -f "$STATE.key" ] || exit 0
    KEY=$(cat "$STATE.key")
    if grep -q 'No such key' "$STATE.orig"; then
      printf 'remove %s\n' "$KEY" | $SCUTIL
    else
      # Rebuild the saved dictionary: scalars, numbers and string arrays.
      /usr/bin/awk -v key="$KEY" '
        BEGIN { print "d.init" }
        /^  [A-Za-z]+ : <array> \{/ { arr = $1; vals = ""; next }
        arr != "" && /^  \}/ { print "d.add " arr " *" vals; arr = ""; next }
        arr != "" && /^    [0-9]+ : / { sub(/^    [0-9]+ : /, ""); vals = vals " " $0; next }
        /^  [A-Za-z]+ : / {
          k = $1; v = $0; sub(/^  [A-Za-z]+ : /, "", v)
          if (v ~ /^[0-9]+$/) print "d.add " k " # " v; else print "d.add " k " " v
        }
        END { print "set " key }
      ' "$STATE.orig" | $SCUTIL
    fi
    rm -f "$STATE.key" "$STATE.orig"
    ;;
  *) echo "usage: $0 set <port> | restore" >&2; exit 2 ;;
esac
