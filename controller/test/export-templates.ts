// Writes the tenant-templates ConfigMap (deploy/templates.sh on stdin) to
// test/.templates, so tests render from the repo's real manifests.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
const cm = parse(readFileSync(0, 'utf8')) as { data: Record<string, string> };
mkdirSync('test/.templates', { recursive: true });
for (const [k, v] of Object.entries(cm.data)) writeFileSync(`test/.templates/${k}`, v);
