# Google sign-in for the tenant UI: deferred

**Status: planned, not started (decided 2026-10-08, to be done later).**
Today the UI has its own users (`tenant-system/tenant-ui-users`, scrypt
hashes) and one account, `admin`. This file records what was decided and
what has to exist before the work can begin.

## Decisions so far

1. **Approach A: a real hostname with HTTPS.** Google only redirects back to
   `https` URIs on a hostname (not a raw IP) whose top-level domain is on the
   public suffix list ([Google's redirect URI rules](https://developers.google.com/identity/protocols/oauth2/web-server)).
   The UI today is `http://10.30.30.226:30310`, and the site domain
   `projects.phoenix.tyo` does not qualify (`.tyo` is not a public TLD).
   Google never has to *reach* the host -- only the user's browser does -- so
   the name may point at a private node IP. This also ends the UI's (and could
   end Grafana's) plain HTTP.
   Rejected: Google's device-code flow (works over HTTP on the IP, but the
   code-entry step is a known phishing pattern) and per-user SSH tunnels.
2. **Who may sign in: the whole Midokura Google Workspace domain**, checked
   with the ID token's `hd` claim (exact domain to confirm).
3. **Authorization by role**, per user or, better, per group.

## Open: roles, and where they come from

Sign-in proves who someone is; what they may do needs roles. A proposal:

| role | may |
| --- | --- |
| `viewer` | see capacity, tenants, status, conditions, drift |
| `operator` | + create and edit tenants, switch Observe/Manage, view credentials and download kubeconfigs |
| `admin` | + delete tenants, manage role bindings |

Every action is already audited; the log would record the Google identity
and the role used.

Two ways to map people to roles -- **to decide**:

- **Per user**: a Secret or ConfigMap in `tenant-system` mapping email ->
  role, edited by an admin (or from the UI). Simple; no extra Google
  permissions.
- **Per group**: Google Groups such as `midori-operators@...` -> role.
  Google's ID token does **not** carry group membership, so the UI would have
  to ask Google at sign-in: the Cloud Identity Groups API (or the Admin SDK
  Directory API) with a service account granted read access to group
  membership (Workspace admin action: domain-wide delegation, or the Groups
  Reader admin role). Membership changes then apply at the next sign-in.
  Better for a team; needs a Workspace admin once.

Either way, a sign-in from the domain with no role mapped gets **no access**
(not `viewer`), and the local `admin` account stays as a break-glass login.

## Prerequisites (none exist yet)

- [ ] **Hostname** under a domain Midokura controls, e.g.
      `tenants.midori.<domain>`, resolving (publicly or on the internal DNS
      users have) to a node IP. Who manages that DNS zone?
- [ ] **Certificate** for it: Let's Encrypt via cert-manager with a DNS-01
      challenge (needs an API token for the DNS provider), or the company CA
      if browsers already trust it. Midori has no cert-manager on the host
      today (only inside tenant-phoenix-serving's vCluster).
- [ ] **TLS in front of the UI**: the UI terminating TLS itself, or an
      ingress on the host (k3s traefik is disabled on midori; no Octavia, so
      a NodePort on 443-ish or hostPort). To decide with the hostname.
- [ ] **Google OAuth client**, created in Midokura's Google Cloud project:
      type "Web application", authorized redirect URI
      `https://<hostname>/auth/callback`. Client ID and secret go into a
      Secret in `tenant-system` -- never into the repo.
- [ ] **Group lookup** (only if roles come from groups): a service account
      with read access to group membership, approved by a Workspace admin.
- [ ] **Role mapping** decided (per user or per group) and the first admins
      named.

## How it would be built

- OpenID Connect authorization-code flow with PKCE and `state`/`nonce`;
  `GET /auth/login` -> Google -> `GET /auth/callback`.
- The server verifies the ID token itself: signature against Google's JWKS
  (cached), `aud` = our client ID, `iss` = accounts.google.com, `exp`,
  `email_verified`, `hd` = the Workspace domain.
- The existing session cookie, CSRF checks and audit log stay; the session
  carries email and role, and every API route checks the role.
- The UI pod needs egress to Google's OAuth and JWKS endpoints (it has it:
  `tenant-system` is not a tenant namespace).
- Tests: token verification against forged tokens (wrong `aud`, `iss`, `hd`,
  expired, bad signature), role enforcement on every route, and the
  break-glass login, in addition to the existing `test/ui-api.sh` and
  screenshot runs.

Estimated half a day to a day once the prerequisites exist, more if roles
come from Google Groups.
