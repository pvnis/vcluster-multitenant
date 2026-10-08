#!/usr/bin/env python3
"""Creates (idempotently) one Grafana org per tenant, its datasources, its
user and its dashboards, and checks that the user can reach nothing else.

    python3 grafana-tenants.py http://10.30.30.204:30300 \
        ~/midori-build/grafana-admin ~/midori-build/grafana-users \
        tenant-nv-a tenant-nv-b tenant-phoenix

The admin password file holds the Grafana admin password. Each tenant's
password is read from <users-dir>/<tenant>, and generated there (mode 600) if
absent. Run again after adding a tenant; nothing is duplicated.

What a tenant org contains, and why it is safe:
  - Prometheus -> http://prom-proxy-<tenant>:8080, the tenant's
    prom-label-proxy, which pins every query to namespace="<tenant>".
  - Loki       -> loki:3100 with X-Scope-OrgID: <tenant>, so only that
    tenant's log streams exist as far as the query is concerned.
  - The tenant user is an org EDITOR (dashboards, Explore), not an org Admin:
    an Admin can edit datasources and so could aim them at Prometheus itself
    or at another Loki tenant. The script verifies the user belongs to exactly
    one org; with auto_assign_org=false Grafana adds no other.
"""
import base64, json, os, secrets, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVING_TENANTS = {"tenant-phoenix", "tenant-phoenix-serving"}  # orgs that also get the vLLM dashboard


class Grafana:
    def __init__(self, url, user, password):
        self.url = url.rstrip("/")
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    def call(self, method, path, body=None, org=None, ok=(200,)):
        req = urllib.request.Request(self.url + path, method=method,
                                     data=None if body is None else json.dumps(body).encode())
        req.add_header("Authorization", self.auth)
        req.add_header("Content-Type", "application/json")
        if org is not None:
            req.add_header("X-Grafana-Org-Id", str(org))
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            data = e.read()
            if e.code in ok:
                return e.code, json.loads(data or b"null")
            raise SystemExit(f"{method} {path}: HTTP {e.code} {data[:300]!r}")


def password_for(users_dir, tenant):
    os.makedirs(users_dir, mode=0o700, exist_ok=True)
    path = os.path.join(users_dir, tenant)
    if not os.path.exists(path):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_urlsafe(18) + "\n")
    with open(path) as f:
        return f.read().strip()


def upsert_datasource(g, org, ds):
    status, _ = g.call("GET", f"/api/datasources/uid/{ds['uid']}", org=org, ok=(200, 404))
    if status == 404:
        g.call("POST", "/api/datasources", ds, org=org)
    else:
        g.call("PUT", f"/api/datasources/uid/{ds['uid']}", ds, org=org)


def ensure_tenant(g, tenant, password):
    status, o = g.call("GET", f"/api/orgs/name/{tenant}", ok=(200, 404))
    org = o["id"] if status == 200 else g.call("POST", "/api/orgs", {"name": tenant})[1]["orgId"]

    upsert_datasource(g, org, {
        "name": "Prometheus", "uid": "prom", "type": "prometheus", "access": "proxy", "isDefault": True,
        "url": f"http://prom-proxy-{tenant}.observability.svc:8080"})
    upsert_datasource(g, org, {
        "name": "Loki", "uid": "loki", "type": "loki", "access": "proxy",
        "url": "http://loki.observability.svc:3100",
        "jsonData": {"httpHeaderName1": "X-Scope-OrgID"},
        "secureJsonData": {"httpHeaderValue1": tenant}})

    status, u = g.call("GET", f"/api/users/lookup?loginOrEmail={tenant}", ok=(200, 404))
    if status == 404:
        uid = g.call("POST", "/api/admin/users", {"name": tenant, "login": tenant, "email": f"{tenant}@midori.local",
                                                  "password": password, "OrgId": org})[1]["id"]
    else:
        uid = u["id"]
        g.call("PUT", f"/api/admin/users/{uid}/password", {"password": password})
    # Editor in its own org; member of nothing else. Grafana 12 ignores OrgId
    # above when auto_assign_org=false and instead creates a PERSONAL org named
    # after the user's email, with the user as its Admin (measured). So add the
    # membership explicitly, switch the user to it, then drop every other
    # membership and delete the personal org.
    members = {m["userId"]: m for m in g.call("GET", f"/api/orgs/{org}/users")[1]}
    if uid in members:
        g.call("PATCH", f"/api/orgs/{org}/users/{uid}", {"role": "Editor"})
    else:
        g.call("POST", f"/api/orgs/{org}/users", {"loginOrEmail": tenant, "role": "Editor"})
    g.call("POST", f"/api/users/{uid}/using/{org}")
    for m in g.call("GET", f"/api/users/{uid}/orgs")[1]:
        if m["orgId"] == org:
            continue
        if m["name"] == f"{tenant}@midori.local":
            # The user is that org's only Admin, which Grafana will not
            # remove ("Cannot remove last organization admin"); deleting the
            # org takes the membership with it.
            g.call("DELETE", f"/api/orgs/{m['orgId']}")
        else:
            g.call("DELETE", f"/api/orgs/{m['orgId']}/users/{uid}")
    orgs = g.call("GET", f"/api/users/{uid}/orgs")[1]
    assert [(m["orgId"], m["role"]) for m in orgs] == [(org, "Editor")], f"{tenant}: unexpected memberships {orgs}"

    boards = ["tenant-overview.json"] + (["tenant-serving.json"] if tenant in SERVING_TENANTS else [])
    for name in boards:
        with open(os.path.join(HERE, "dashboards", name)) as f:
            dash = json.load(f)
        g.call("POST", "/api/dashboards/db", {"dashboard": dash, "overwrite": True}, org=org)
    print(f"{tenant}: org {org}, user {tenant} (Editor, only member of this org), dashboards {', '.join(boards)}")


def main():
    if len(sys.argv) < 5:
        raise SystemExit(__doc__)
    url, admin_file, users_dir, tenants = sys.argv[1], sys.argv[2], os.path.expanduser(sys.argv[3]), sys.argv[4:]
    with open(os.path.expanduser(admin_file)) as f:
        g = Grafana(url, "admin", f.read().strip())
    g.call("PUT", "/api/orgs/1", {"name": "midori admin"})
    for t in tenants:
        ensure_tenant(g, t, password_for(users_dir, t))


if __name__ == "__main__":
    main()
