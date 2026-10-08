# API and security checks against a running tenant UI.
#   test/ui-api.sh http://10.30.30.54:30310 [password-file]
# The password file holds the admin password (default ~/midori-build/tenant-ui-admin).
B=$1; J=$(mktemp); P=$(cat "${2:-$HOME/midori-build/tenant-ui-admin}")
c(){ curl -s -o /tmp/ui-body -w '%{http_code}' "$@"; }
echo "unauthenticated overview:        $(c $B/api/overview)  (want 401)"
echo "wrong password:                  $(c -X POST -H 'content-type: application/json' -d '{"user":"admin","password":"nope"}' $B/api/login)  (want 401)"
echo "unknown user:                    $(c -X POST -H 'content-type: application/json' -d '{"user":"nobody","password":"nope"}' $B/api/login)  (want 401)"
echo "login:                           $(c -c $J -X POST -H 'content-type: application/json' -d "{\"user\":\"admin\",\"password\":\"$P\"}" $B/api/login)  (want 200)"
grep -o 'HttpOnly.*' $J >/dev/null; echo "cookie flags:                    $(grep tenant_ui $J | awk '{print "httponly=" ($1 ~ /HttpOnly/ ? "yes":"no")}')"
echo "me:                              $(c -b $J $B/api/me) $(cat /tmp/ui-body)"
echo "overview:                        $(c -b $J $B/api/overview) tenants=$(jq -r '[.tenants[].name]|join(",")' /tmp/ui-body) gpus=$(jq -c '.capacity.gpus' /tmp/ui-body)"
echo "write without X-Tenant-UI:       $(c -b $J -X PUT -H 'content-type: application/json' -d '{}' $B/api/tenants/tenant-nv-b)  (want 403)"
echo "write with foreign Origin:       $(c -b $J -X PUT -H 'X-Tenant-UI: 1' -H 'Origin: http://evil.example' -H 'content-type: application/json' -d '{}' $B/api/tenants/tenant-nv-b)  (want 403)"
echo "invalid spec:                    $(c -b $J -X POST -H 'X-Tenant-UI: 1' -H 'content-type: application/json' -d '{"name":"tenant-x","spec":{"quota":{"gpus":9,"gpuMemoryMiB":1}}}' $B/api/tenants) $(cat /tmp/ui-body)"
echo "bad name:                        $(c -b $J -X POST -H 'X-Tenant-UI: 1' -H 'content-type: application/json' -d '{"name":"../etc","spec":{"quota":{"gpus":0,"gpuMemoryMiB":0}}}' $B/api/tenants) $(cat /tmp/ui-body)"
echo "delete without confirm:          $(c -b $J -X DELETE -H 'X-Tenant-UI: 1' -H 'content-type: application/json' -d '{"confirm":"wrong"}' $B/api/tenants/tenant-nv-b) $(cat /tmp/ui-body)"
echo "path traversal (static):         $(c $B/..%2f..%2fetc%2fpasswd) $(c $B/%2e%2e/package.json)  (want 404 404)"
echo "security headers:                $(curl -s -D - -o /dev/null $B/ | grep -ciE '^(content-security-policy|x-frame-options|x-content-type-options|referrer-policy):') of 4"
echo "logout then overview:            $(c -b $J -X POST -H 'X-Tenant-UI: 1' $B/api/logout) $(c -b $J $B/api/overview)  (want 200 401)"
rm -f $J /tmp/ui-body
