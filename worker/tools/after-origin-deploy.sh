#!/bin/bash
# Run ONCE after either origin project has been redeployed.
#
# WHY IT IS NEEDED: anonymous 402 challenges are served by the worker at the edge, from a module
# GENERATED out of the golden fixtures. Until this runs after a deploy that changes a challenge,
# the origin says one thing and the edge says another: the new declaration would exist only for
# callers that pay, while anyone reading the challenge anonymously still sees the old one.
set -e
cd "$(dirname "$0")/.."
R=~/Documents/GitHub

echo "1/4  recapture the fixtures from the freshly deployed origins (the edge serves both projects)"
(cd "$R/GBLIN_WEBAPP/test/x402-golden" && node capture.mjs)
(cd "$R/GBLIN-Sentinel/test/x402-golden" && node capture.mjs)

echo "2/4  regenerate the edge challenge module from both fixture sets"
node tools/generate-challenges.mjs

echo "3/4  deploy the worker"
npx wrangler deploy

echo "4/4  cross-check: edge against origin, byte for byte"
(cd "$R/GBLIN_WEBAPP/test/x402-golden" && node verify.mjs | tail -3)
(cd "$R/GBLIN_WEBAPP/test/x402-golden" && node verify-methods.mjs | tail -3)
(cd "$R/GBLIN-Sentinel/test/x402-golden" && node verify.mjs | tail -3)
echo
echo "Done. If any line above does not report a byte-for-byte match, do not leave it: investigate."
