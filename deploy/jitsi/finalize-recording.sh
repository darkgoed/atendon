#!/bin/sh
set -eu

recording_dir="${1:?Jibri must pass the finalized recording directory}"
case "$recording_dir" in
  /config/recordings/*) ;;
  *) echo "Refusing to finalize a directory outside /config/recordings" >&2; exit 1 ;;
esac

# The root bind mount is setgid and Jibri has the host PM2 group as a
# supplementary group. Preserve that group and make finalized media removable
# by the host worker before publishing the readiness marker.
find "$recording_dir" -type d -exec chmod 2770 {} +
find "$recording_dir" -type f -exec chmod 0660 {} +
touch "$recording_dir/.atendon-ready"
chmod 0660 "$recording_dir/.atendon-ready"
