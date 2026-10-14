# OpenStack load balancers for Services

`openstack-cloud-controller-manager` (chart 2.36.5, v1.36.0) turns every
`type: LoadBalancer` Service into an Octavia load balancer: an amphora VM in
the project, with the Service's NodePort on each node as members.

    kubectl label node midori-eye-0 node.kubernetes.io/exclude-from-external-load-balancers=true
    kubectl -n kube-system create secret generic cloud-config --from-file=cloud.conf   # never commit
    helm upgrade --install occm cpo/openstack-cloud-controller-manager --version 2.36.5 -n kube-system -f values.yaml
    kubectl apply -f ../load-balancer-guard.yaml

`cloud.conf` (on midori-cp-0 at `~/midori-build/cloud.conf`, mode 600):

    [Global]
    auth-url=https://openstack-lab.phoenix.tyo:5000
    application-credential-id=...            # octavia-api-key: load-balancer_member, member, reader
    application-credential-secret=...
    region=RegionOne
    tls-insecure=true                        # KollaTestCA is not available to us
    [LoadBalancer]
    lb-provider=amphora
    subnet-id=b09b3e04-f695-416b-ab16-fc0cd22df8da         # vpn_public_network, 10.30.30.0/24
    floating-network-id=898b67c4-e15f-4c02-9f15-b67152d621a2   # external-net, 119.15.113.0/24 (public)
    internal-lb=true                         # no floating IP unless a Service asks
    create-monitor=true

Notes:
- **Service controller only.** The nodes have no providerID, and
  `cloud-node-lifecycle` would delete Node objects it cannot match to an
  instance.
- **Port 10268.** k3s's own embedded cloud controller holds 127.0.0.1:10258 on
  the servers' host network.
- **Server selector.** k3s labels its servers `control-plane=true`, not `""`.
- **Members** are the five nodes. midori-eye-0 is excluded: it lacks the
  `midori-nodeports` security group that admits the amphorae to the NodePort
  range (`../OPENSTACK-GAPS.md`).

Tenants: `loadBalancers.count` in the Tenant spec is the
`services.loadbalancers` quota, 0 by default. `loadBalancers.public` lets a
Service take a floating IP, with annotation
`service.beta.kubernetes.io/openstack-internal-load-balancer: "false"`.
`../load-balancer-guard.yaml` refuses every other annotation of this
controller and `spec.loadBalancerIP`: they pick specific floating IPs or load
balancers in a project shared with other people.

First user: tenant-phoenix-serving's Gateway, 10.30.30.12:8080, internal
(2026-10-14).
