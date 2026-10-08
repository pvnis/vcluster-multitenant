// Prints a password hash for Secret tenant-system/tenant-ui-users.
// The password is read from stdin, so it never appears in shell history or
// in the process list:
//   printf '%s' "$PASSWORD" | node src/ui/hash-password.ts
import { readFileSync } from 'node:fs';
import { hashPassword } from './auth.ts';

const pw = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (pw.length < 12) {
  console.error('password must be at least 12 characters');
  process.exit(1);
}
console.log(await hashPassword(pw));
