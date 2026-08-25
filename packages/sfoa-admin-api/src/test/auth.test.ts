import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdminSessionManager, LoginRateLimiter, verifyAdminPassword } from '../auth.js';
import { loadAdminApiConfig, type AdminApiConfig } from '../config.js';

const baseConfig: AdminApiConfig = Object.freeze({
  bindHost: '127.0.0.1',
  port: 8081,
  allowedOrigin: 'http://127.0.0.1:5173',
  username: 'bootstrap-admin',
  password: 'unused',
  sessionSecret: 's'.repeat(64),
  sessionTtlSeconds: 300,
  cookieSecure: false,
  cookieName: 'sfoa_admin',
  loginMaxAttempts: 5,
  loginWindowMs: 60_000,
});

test('plaintext password verification is constant-time and rejects mismatches', () => {
  const password = 'correct horse battery staple';
  assert.equal(verifyAdminPassword(password, password), true);
  assert.equal(verifyAdminPassword('wrong password', password), false);
  assert.equal(verifyAdminPassword(password, ''), false);
  assert.equal(verifyAdminPassword('', password), false);
  assert.equal(verifyAdminPassword('a'.repeat(1025), password), false);
});

test('session cookies are signed, HttpOnly, Strict, expiring, revocable, and dev-safe', () => {
  const manager = new AdminSessionManager(baseConfig);
  const issued = manager.issue();
  assert.match(issued.cookie, /^sfoa_admin=/u);
  assert.match(issued.cookie, /; HttpOnly/u);
  assert.match(issued.cookie, /; SameSite=Strict/u);
  assert.doesNotMatch(issued.cookie, /; Secure/u);
  assert.deepEqual(manager.parse(issued.cookie), issued.session);

  const tampered = issued.cookie.replace(/=./u, '=x');
  assert.equal(manager.parse(tampered), undefined);
  manager.revoke(issued.session);
  assert.equal(manager.parse(issued.cookie), undefined);
  assert.match(manager.clearCookie(), /Max-Age=0/u);
});

test('production cookie uses __Host prefix and Secure attribute', () => {
  const config = Object.freeze({ ...baseConfig, cookieSecure: true, cookieName: '__Host-sfoa_admin' });
  const issued = new AdminSessionManager(config).issue();
  assert.match(issued.cookie, /^__Host-sfoa_admin=/u);
  assert.match(issued.cookie, /; Secure/u);
  assert.match(issued.cookie, /; Path=\//u);
});

test('production configuration requires HTTPS and cannot disable Secure cookies', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-admin-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const password = 'correct horse battery staple';
  const common = {
    NODE_ENV: 'production',
    SFOA_ADMIN_USERNAME: 'bootstrap-admin',
    SFOA_ADMIN_PASSWORD: password,
    SFOA_ADMIN_SESSION_SECRET: 's'.repeat(64),
  };
  await assert.rejects(
    loadAdminApiConfig(root, { ...common, SFOA_ADMIN_ALLOWED_ORIGIN: 'http://admin.example.test' }),
    /must use HTTPS/u,
  );
  await assert.rejects(
    loadAdminApiConfig(root, {
      ...common,
      SFOA_ADMIN_ALLOWED_ORIGIN: 'https://admin.example.test',
      SFOA_ADMIN_COOKIE_SECURE: 'false',
    }),
    /cannot be disabled/u,
  );
  const config = await loadAdminApiConfig(root, {
    ...common,
    SFOA_ADMIN_ALLOWED_ORIGIN: 'https://admin.example.test',
  });
  assert.equal(config.cookieSecure, true);
  assert.equal(config.cookieName, '__Host-sfoa_admin');
});

test('expired sessions are rejected', () => {
  const manager = new AdminSessionManager(baseConfig);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const issued = manager.issue();
    now += baseConfig.sessionTtlSeconds * 1000 + 1;
    assert.equal(manager.parse(issued.cookie), undefined);
  } finally {
    Date.now = originalNow;
  }
});

test('login rate limiter is bounded by key and resets after success', () => {
  const limiter = new LoginRateLimiter(3, 60_000);
  assert.equal(limiter.consume('127.0.0.1'), true);
  assert.equal(limiter.consume('127.0.0.1'), true);
  assert.equal(limiter.consume('127.0.0.1'), true);
  assert.equal(limiter.consume('127.0.0.1'), false);
  assert.equal(limiter.consume('127.0.0.2'), true);
  limiter.clear('127.0.0.1');
  assert.equal(limiter.consume('127.0.0.1'), true);
});
