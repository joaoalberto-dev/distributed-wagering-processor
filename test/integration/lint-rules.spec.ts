/**
 * Proves that `.oxlintrc.json` enforces the dependency rule: a file that
 * breaks a layer rule is reported, and a file that respects it is not.
 *
 * The probes live in a temporary copy of the layer folders with the real
 * configuration, minus type-aware linting (which needs the project's
 * tsconfig and is not what is under test).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const PROJECT_ROOT = new URL('../..', import.meta.url).pathname;
const OXLINT = join(PROJECT_ROOT, 'node_modules/.bin/oxlint');

type Probe = {
  readonly file: string;
  readonly source: string;
  /** The rule expected to report the file, or null when the file is valid. */
  readonly rule: 'eslint(no-restricted-imports)' | 'import(no-cycle)' | null;
};

const probes: Probe[] = [
  // domain
  {
    file: 'src/domain/to-application.ts',
    source: `export * from '../application/x.js';`,
    rule: 'eslint(no-restricted-imports)',
  },
  {
    file: 'src/domain/to-infrastructure.ts',
    source: `export * from '../infrastructure/x.js';`,
    rule: 'eslint(no-restricted-imports)',
  },
  {
    file: 'src/domain/to-zod.ts',
    source: `export * from 'zod';`,
    rule: 'eslint(no-restricted-imports)',
  },
  {
    file: 'src/domain/to-scoped-package.ts',
    source: `export * from '@nestjs/common';`,
    rule: 'eslint(no-restricted-imports)',
  },
  {
    file: 'src/domain/to-node-fs.ts',
    source: `export * from 'node:fs';`,
    rule: 'eslint(no-restricted-imports)',
  },
  {
    file: 'src/domain/to-node-crypto.ts',
    source: `export { randomUUID } from 'node:crypto';`,
    rule: null,
  },
  {
    file: 'src/domain/to-domain.ts',
    source: `export * from './money/x.js';`,
    rule: null,
  },
  {
    file: 'src/domain/spec-exempt.spec.ts',
    source: `export * from '../infrastructure/x.js';`,
    rule: null,
  },
  // application
  {
    file: 'src/application/to-domain.ts',
    source: `export * from '../domain/x.js';`,
    rule: null,
  },
  {
    file: 'src/application/to-contracts.ts',
    source: `export * from '../contracts/x.js';`,
    rule: 'eslint(no-restricted-imports)',
  },
  {
    file: 'src/application/to-infrastructure.ts',
    source: `export * from '../infrastructure/x.js';`,
    rule: 'eslint(no-restricted-imports)',
  },
  {
    file: 'src/application/to-bootstrap.ts',
    source: `export * from '../bootstrap/x.js';`,
    rule: 'eslint(no-restricted-imports)',
  },
  {
    file: 'src/application/to-prom-client.ts',
    source: `export * from 'prom-client';`,
    rule: 'eslint(no-restricted-imports)',
  },
  // contracts
  {
    file: 'src/contracts/to-zod.ts',
    source: `export * from 'zod';`,
    rule: null,
  },
  {
    file: 'src/contracts/to-domain.ts',
    source: `export * from '../domain/x.js';`,
    rule: 'eslint(no-restricted-imports)',
  },
  // interface
  {
    file: 'src/interface/to-application.ts',
    source: `export * from '../application/x.js';`,
    rule: null,
  },
  {
    file: 'src/interface/to-infrastructure.ts',
    source: `export * from '../infrastructure/x.js';`,
    rule: 'eslint(no-restricted-imports)',
  },
  {
    file: 'src/interface/to-bootstrap.ts',
    source: `export * from '../bootstrap/x.js';`,
    rule: 'eslint(no-restricted-imports)',
  },
  // infrastructure
  {
    file: 'src/infrastructure/to-application.ts',
    source: `export * from '../application/x.js';`,
    rule: null,
  },
  {
    file: 'src/infrastructure/to-interface.ts',
    source: `export * from '../interface/x.js';`,
    rule: 'eslint(no-restricted-imports)',
  },
  {
    file: 'src/infrastructure/to-bootstrap.ts',
    source: `export * from '../bootstrap/x.js';`,
    rule: 'eslint(no-restricted-imports)',
  },
  // bootstrap imports everything
  {
    file: 'src/bootstrap/to-infrastructure.ts',
    source: `export * from '../infrastructure/x.js';`,
    rule: null,
  },
  // cycles, in any layer
  {
    file: 'src/domain/cycle/a.ts',
    source: `import { b } from './b.js';\nexport const a = (): unknown => b;`,
    rule: 'import(no-cycle)',
  },
  {
    file: 'src/domain/cycle/b.ts',
    source: `import { a } from './a.js';\nexport const b = (): unknown => a;`,
    rule: 'import(no-cycle)',
  },
];

type Diagnostic = { code: string; filename: string };

describe('.oxlintrc.json layer rules', () => {
  let workspace: string;
  let reported: Map<string, Set<string>>;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'wagering-lint-'));
    const config = JSON.parse(
      await readFile(join(PROJECT_ROOT, '.oxlintrc.json'), 'utf8'),
    ) as {
      $schema?: string;
      options?: Record<string, unknown>;
    };
    delete config.$schema;
    config.options = { ...config.options, typeAware: false };
    await writeFile(join(workspace, '.oxlintrc.json'), JSON.stringify(config));

    for (const probe of probes) {
      const path = join(workspace, probe.file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${probe.source}\n`);
    }
    const lint = Bun.spawnSync([OXLINT, '--format', 'json', 'src/'], {
      cwd: workspace,
    });
    const output = lint.stdout.toString();
    const { diagnostics } = JSON.parse(output) as { diagnostics: Diagnostic[] };
    reported = new Map();
    for (const { code, filename } of diagnostics) {
      const codes = reported.get(filename) ?? new Set<string>();
      codes.add(code);
      reported.set(filename, codes);
    }
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it.each(probes.map((probe) => [probe.file, probe.rule] as const))(
    '%s → %s',
    (file, rule) => {
      const codes = [...(reported.get(file) ?? [])];
      expect(codes).toEqual(rule === null ? [] : [rule]);
    },
  );
});
