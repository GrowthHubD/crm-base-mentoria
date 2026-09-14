// Cria o `.env` uma única vez, a partir do `.env.example`, com segredos
// sorteados. Recusa sobrescrever: rotacionar a ENCRYPTION_KEY de uma
// instalação existente inutiliza as conexões já gravadas.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

try {
  const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const values = {
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    CRON_SECRET: randomBytes(32).toString('hex'),
  };
  let output = template;
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    output = pattern.test(output) ? output.replace(pattern, `${name}=${value}`) : `${output}\n${name}=${value}\n`;
  }
  writeFileSync(new URL('../.env', import.meta.url), output, { flag: 'wx', mode: 0o600 });
  console.log('.env criado com segredos sorteados. Preencha DATABASE_URL com um banco de desenvolvimento antes do db:push.');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('.env já existe; nenhuma configuração ou chave foi alterada.');
  } else {
    console.error('Não foi possível criar o .env:', error.code ?? 'erro desconhecido');
  }
  process.exitCode = 1;
}
