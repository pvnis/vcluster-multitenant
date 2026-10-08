// Login for the tenant UI. There is no identity provider on midori, so users
// are entries in Secret tenant-system/tenant-ui-users: key = username,
// value = "scrypt$<N>$<salt b64>$<hash b64>" (make one with
// `node src/ui/hash-password.ts`). Sessions are random tokens held in memory
// (one replica); they expire after SESSION_HOURS.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { V1Secret } from '@kubernetes/client-node';
import type { Kube } from '../kube.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; maxmem: number }) => Promise<Buffer>;
// scrypt needs 128 * N * r bytes; at N = 2^15 that is exactly Node's default
// 32 MiB ceiling, which it refuses ("memory limit exceeded").
const maxmem = (N: number) => 256 * N * 8 + (1 << 20);
const USERS = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'tenant-ui-users', namespace: process.env.CONTROLLER_NAMESPACE ?? 'tenant-system' } };
const SESSION_HOURS = Number(process.env.SESSION_HOURS ?? 12);

export async function hashPassword(password: string, N = 1 << 15): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, { N, maxmem: maxmem(N) });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  if (!(Number(n) >= 1024 && Number(n) <= 1 << 20)) return false;
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length, { N: Number(n), maxmem: maxmem(Number(n)) });
  return got.length === want.length && timingSafeEqual(got, want);
}

interface Session { user: string; expires: number }

export class Auth {
  private readonly sessions = new Map<string, Session>();
  // Failed logins per client address: count and earliest next attempt.
  private readonly failures = new Map<string, { n: number; until: number }>();
  private readonly kube: Kube;

  constructor(kube: Kube) {
    this.kube = kube;
  }

  // Constant work whether or not the user exists, so a probe cannot tell
  // existing usernames from others by timing.
  private static readonly DUMMY = 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

  async login(user: string, password: string, client: string): Promise<string | { retryAfter: number } | undefined> {
    const now = Date.now();
    const f = this.failures.get(client);
    if (f && f.until > now) return { retryAfter: Math.ceil((f.until - now) / 1000) };
    const secret = await this.kube.read<V1Secret>(USERS);
    const enc = secret?.data?.[user];
    const stored = enc ? Buffer.from(enc, 'base64').toString() : Auth.DUMMY;
    const ok = (await verifyPassword(password, stored)) && !!enc;
    if (!ok) {
      const n = (f?.n ?? 0) + 1;
      // From the fifth failure: 30 s, doubling, capped at 15 minutes.
      const wait = n >= 5 ? Math.min(30_000 * 2 ** (n - 5), 900_000) : 0;
      this.failures.set(client, { n, until: now + wait });
      return undefined;
    }
    this.failures.delete(client);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { user, expires: now + SESSION_HOURS * 3_600_000 });
    return token;
  }

  user(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expires < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return s.user;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}
