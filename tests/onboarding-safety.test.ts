/**
 * O onboarding não pode ter efeito colateral escondido.
 *
 * `npm run setup` cria segredos válidos e distintos e nunca sobrescreve um
 * `.env` existente. `cliente:novo` exige um modo explícito: sem flag não faz
 * nada; `--so-verificar` só roda o smoke; `--so-banco` não cria recurso na
 * nuvem nem publica; cliente já provisionado não é reprovisionado (rotacionar
 * a chave de uma instalação viva quebra as conexões gravadas).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { parse } from 'dotenv';

describe('salvaguardas do onboarding', () => {
  it('setup cria segredos válidos e únicos uma vez, e preserva instalação existente', () => {
    const root = path.resolve('.test-temp', `setup-${randomUUID()}`);
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts/setup-local.mjs'), readFileSync('scripts/setup-local.mjs'));
    writeFileSync(path.join(root, '.env.example'), 'DATABASE_URL=\nENCRYPTION_KEY=placeholder\nBETTER_AUTH_SECRET=placeholder\n');
    const script = path.join(root, 'scripts/setup-local.mjs');
    expect(spawnSync(process.execPath, [script]).status).toBe(0);
    const before = readFileSync(path.join(root, '.env'), 'utf8');
    const values = parse(before);
    for (const key of ['ENCRYPTION_KEY', 'BETTER_AUTH_SECRET', 'CRON_SECRET']) expect(values[key]).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set([values.ENCRYPTION_KEY, values.BETTER_AUTH_SECRET, values.CRON_SECRET]).size).toBe(3);
    expect(spawnSync(process.execPath, [script]).status).toBe(1);
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(before);
  });

  function provision(args: string[], existing = false) {
    const calls: string[][] = [];
    const writes: string[] = [];
    let exitCode: number | undefined;
    const code = ts.transpileModule(readFileSync('scripts/provisionar-cliente.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    try {
      runInNewContext(code, {
        exports: {},
        console: { log() {}, error() {} },
        Buffer,
        process: {
          argv: ['node', 'provision', ...args],
          env: {},
          platform: 'linux',
          exit(code: number) {
            exitCode = code;
            throw new Error('EXIT');
          },
        },
        require(name: string) {
          if (name === 'dotenv/config') return {};
          if (name === 'node:crypto') return { randomBytes: (size: number) => Buffer.alloc(size, 7) };
          if (name === 'node:child_process')
            return {
              execFileSync: (cmd: string, argv: string[]) => {
                calls.push([cmd, ...argv]);
                return '';
              },
            };
          if (name === 'node:fs')
            return {
              existsSync: () => existing,
              mkdirSync: (p: string) => writes.push(p),
              writeFileSync: (p: string) => writes.push(p),
              appendFileSync: (p: string) => writes.push(p),
              readFileSync: () => {
                throw new Error('Unexpected configuration read');
              },
            };
          throw new Error(`Unexpected module ${name}`);
        },
      });
    } catch (error) {
      if ((error as Error).message !== 'EXIT') throw error;
    }
    return { calls, writes, exitCode };
  }

  it('sem modo explícito não há efeito colateral nenhum', () => {
    expect(provision(['example', 'Example'])).toEqual({ calls: [], writes: [], exitCode: 1 });
  });

  it('--so-verificar roda só o smoke: sem deploy, segredo ou escrita de config', () => {
    expect(provision(['example', 'Example', '--so-verificar'])).toEqual({
      calls: [['npx', 'tsx', 'scripts/smoke.ts', 'example']],
      writes: [],
      exitCode: 0,
    });
  });

  it('recusa reprovisionar cliente existente ou escapar da pasta de credenciais', () => {
    expect(provision(['example', 'Example', '--deploy'], true)).toEqual({ calls: [], writes: [], exitCode: 1 });
    expect(provision(['example', '../Another', '--deploy'])).toEqual({ calls: [], writes: [], exitCode: 1 });
  });

  it('--so-banco não cria recurso na nuvem nem publica nada', () => {
    const result = provision(['example', 'Example', '--so-banco']);
    expect(result.exitCode).toBe(0);
    expect(result.calls).toHaveLength(5);
    expect(
      result.calls.every((call) => call[0] === 'npx' && call[1] === 'tsx' && !call.some((arg) => /wrangler|deploy|smoke/.test(arg)))
    ).toBe(true);
  });
});
