# The Kubernetes API load balancer: 10.30.30.106:6443

An Octavia load balancer, `midori-k8s-api`, in front of the three k3s servers.
Created directly in Octavia, not as a Service: the API server listens on the
servers' host network, not on a NodePort.

    VIP        10.30.30.106 (vpn_public_network), no floating IP
    listener   TCP 6443, client/member idle timeouts 1 h (Octavia's 50 s default
               would cut long-lived watches)
    pool       ROUND_ROBIN over midori-cp-0/1/2:6443
    monitor    TLS-HELLO every 5 s. Not HTTP /readyz: k3s disables anonymous
               auth, so /readyz answers 401 whether the server is ready or not.

Security group `midori-nodeports` also admits TCP 6443 from 10.30.30.0/24
(`OPENSTACK-GAPS.md`).

Built 2026-10-14. Creating it in a single call, with listener, pool, monitor
and members inline, left the load balancer in ERROR with every child stuck
in PENDING_CREATE. Built step by step (load balancer, listener, pool, monitor,
then each member, waiting for ACTIVE between steps), every step succeeded.
Build it that way again.

**Certificate.** The VIP is in `tls-san` in `/etc/rancher/k3s/config.yaml` on
all three servers (first in the list). Added with a rolling restart (cp-2,
cp-1, then cp-0), after an etcd snapshot `pre-api-lb-tls-san`. k3s shares its
serving certificate between servers through a Secret, so the VIP was served
by all three after the first restart. The config is still updated on each,
so a later restart cannot drop it.

During cp-0's restart the tenant controller's pass hit the in-cluster API
address, 10.43.0.1, and got connection refused from cp-0. Three tenants
showed Degraded until the next pass. Expect that during server restarts.

**Use.** `~/midori-build/midori-admin.kubeconfig` on midori-cp-0 (mode 600) is
k3s's admin kubeconfig with `server: https://10.30.30.106:6443`, for use from
anywhere on the lab network. `~/.kube/config` on the servers still uses
127.0.0.1.

Not changed: the agents (nv-0/1, eye-0) joined through cp-0's IP and use k3s's
client-side balancer (127.0.0.1:6444) over all servers, and Cilium uses the
same. Tenant API servers are still NodePorts on node IPs (`values/midori-tenant.yaml`).
