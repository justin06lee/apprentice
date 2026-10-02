#!/bin/sh
#
# Let apprentice's sandbox start on a Linux that restricts user namespaces.
#
# Ubuntu 23.10 and later hand unprivileged user namespaces only to programs
# AppArmor has a profile for, and Chromium's sandbox — Electron's, and so
# apprentice's — is built on them. Without one, Chromium falls back to its setuid
# helper, finds it is not root-owned (nothing a user installs into their own
# home can be), and aborts before a window exists: apprentice installed cleanly and
# then did nothing at all when launched.
#
# The answer Ubuntu itself uses for Chrome, VS Code, Slack and the rest is a
# profile that names the program and confines nothing else, with `userns`
# allowed. That is what this writes, for the binary `make install` put in
# place. It needs root once. The path does not change between builds, so
# every later `make` finds the profile already there and asks nothing.
#
# Turning the sandbox off (`--no-sandbox`) would also start the app, and is
# not done: the renderer draws text and images taken out of whatever PDFs
# are imported, and model output on top, and the sandbox is what stands
# between a malformed one and the rest of the user's account.
#
#   scripts/apparmor.sh <path to apprentice's binary>

set -eu

bin=$1
profile=/etc/apparmor.d/apprentice
restricted=/proc/sys/kernel/apparmor_restrict_unprivileged_userns

# Nothing restricts namespaces here — any other distribution, or an Ubuntu
# with the restriction switched off — so there is nothing to ask for.
[ "$(cat "$restricted" 2>/dev/null)" = 1 ] || exit 0

wanted="# apprentice, written by its Makefile (scripts/apparmor.sh). Chromium's sandbox
# needs unprivileged user namespaces, which this system grants only to
# programs with a profile. Like the ones Ubuntu ships for Chrome and VS
# Code, this names the program and confines nothing.

abi <abi/4.0>,
include <tunables/global>

profile apprentice $bin flags=(unconfined) {
  userns,

  include if exists <local/apprentice>
}"

if [ -f "$profile" ] && [ "$(cat "$profile")" = "$wanted" ]; then
  exit 0
fi

echo "apprentice: this system gives Chromium's sandbox its namespaces only by AppArmor profile;"
echo "     installing $profile for $bin (sudo, once)"
scratch=$(mktemp)
trap 'rm -f "$scratch"' EXIT
printf '%s\n' "$wanted" > "$scratch"
if ! { sudo install -m 644 "$scratch" "$profile" && sudo apparmor_parser -r "$profile"; }; then
  echo "apprentice: could not install the profile, so apprentice will not start. Run this once:" >&2
  echo "       sudo sh '$(cd "$(dirname "$0")" && pwd)/apparmor.sh' '$bin'" >&2
  exit 1
fi
