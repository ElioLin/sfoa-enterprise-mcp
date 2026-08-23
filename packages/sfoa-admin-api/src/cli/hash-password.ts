import { hashAdminPassword } from '../auth.js';

async function readPassword(): Promise<string> {
  const fromEnvironment = process.env.SFOA_ADMIN_PASSWORD_PLAINTEXT;
  if (fromEnvironment !== undefined) return fromEnvironment;
  if (process.stdin.isTTY) {
    throw new Error('Set SFOA_ADMIN_PASSWORD_PLAINTEXT for this one command or pipe the password through stdin.');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '');
}

const password = await readPassword();
const hash = await hashAdminPassword(password);
process.stdout.write(`${hash}\n`);
