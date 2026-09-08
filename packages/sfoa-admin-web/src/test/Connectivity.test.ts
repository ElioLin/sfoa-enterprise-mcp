import { describe, expect, it } from 'vitest';
import type { SystemStatusDto } from '@sfoa/control-plane';
import {
  bindHostGuidance,
  buildDifyConnectionExample,
  buildInternalConnectionExample,
  buildWeComConnectionExample,
  buildWorkBuddyConnectionExample,
  deriveMcpConnectivity,
  lanMcpUrl,
  loopbackMcpUrl,
  validateExternalMcpUrl,
  wecomChannelEnabled,
} from '../agent/connectivity.js';

describe('MCP network guidance', () => {
  it('identifies 127.0.0.1 as same-host access only', () => {
    const config = deriveMcpConnectivity(status({ MCP_BIND_HOST: '127.0.0.1', MCP_PORT: 8080, MCP_PATH: '/mcp' }));

    expect(loopbackMcpUrl(config)).toBe('http://127.0.0.1:8080/mcp');
    expect(bindHostGuidance(config)).toContain('仅本机');
    expect(bindHostGuidance(config)).toContain('外部 Dify / WorkBuddy');
  });

  it('explains that 0.0.0.0 still needs allowed hosts and firewall', () => {
    const config = deriveMcpConnectivity(status({ MCP_BIND_HOST: '0.0.0.0', MCP_PORT: 8080, MCP_PATH: '/mcp' }));

    expect(lanMcpUrl(config)).toBe('http://<YOUR_LAN_IP>:8080/mcp');
    expect(bindHostGuidance(config)).toContain('MCP_ALLOWED_HOSTS');
    expect(bindHostGuidance(config)).toContain('firewall');
    expect(bindHostGuidance(config)).toContain('不会自动让互联网可访问');
  });

  it('uses the supplied external URL in Dify, WeCom, WorkBuddy, and Internal examples', () => {
    const validation = validateExternalMcpUrl('https://mcp.company.com/mcp');
    expect(validation).toEqual({ valid: true, url: 'https://mcp.company.com/mcp' });
    if (!validation.valid) throw new Error(validation.message);

    const dify = buildDifyConnectionExample(validation.url);
    const wecom = buildWeComConnectionExample(validation.url);
    const workBuddy = buildWorkBuddyConnectionExample(validation.url);
    const internal = buildInternalConnectionExample(validation.url);
    expect(dify).toContain('https://mcp.company.com/mcp');
    expect(wecom).toContain('https://mcp.company.com/mcp');
    expect(workBuddy).toContain('https://mcp.company.com/mcp');
    expect(internal).toContain('https://mcp.company.com/mcp');
    expect(dify).toContain('Bearer <CURRENT_USER_TOKEN>');
    expect(dify).toContain('Identity Source = BUNTU_TOKEN');
    expect(dify).toContain('X-Platform-User-Id = NOT_CONFIGURED');
    expect(wecom).toContain('Bearer <MCP_CLIENT_TOKEN>');
    expect(wecom).toContain('Identity Source = WECOM_HEADER');
    expect(wecom).toContain('X-WeCom-User-Id = <CURRENT_WECOM_USER_ID>');
    expect(wecom).toContain('X-Platform-User-Id = NOT_CONFIGURED');
    expect(wecom).toContain('Transport = Streamable HTTP');
    expect(workBuddy).toContain('Bearer <USER_BOUND_TOKEN>');
    expect(workBuddy).toContain('Identity Source = USER_BOUND_TOKEN');
    expect(workBuddy).toContain('X-Platform-User-Id = NOT_CONFIGURED');
    expect(workBuddy).toContain('Transport = Streamable HTTP');
    expect(internal).toContain('Bearer <MCP_CLIENT_TOKEN>');
    expect(internal).toContain('X-Platform-User-Id = <PLATFORM_USER_ID>');
    expect(internal).toContain('INTERNAL_SERVICE_HEADER');
    // WECOM_HEADER example must never leak another channel's identity semantics.
    expect(`${dify}\n${wecom}\n${workBuddy}`).not.toContain('<PLATFORM_USER_ID>');
    expect(wecom).not.toContain('CURRENT_USER_TOKEN');
    expect(wecom).not.toContain('USER_BOUND_TOKEN');
  });

  it('detects WeCom channel enablement from the identity-header configuration', () => {
    const disabled = deriveMcpConnectivity(status({
      MCP_PLATFORM_USER_HEADER: 'X-Platform-User-Id',
      MCP_PLATFORM_USER_HEADER_ALIASES: ['X-WorkBuddy-Id'],
    }));
    expect(disabled.platformUserHeader).toBe('X-Platform-User-Id');
    expect(disabled.platformUserHeaderAliases).toEqual(['X-WorkBuddy-Id']);
    expect(wecomChannelEnabled(disabled)).toBe(false);

    // Enabled through the alias list (the intended partner-header route), case-insensitively.
    const enabled = deriveMcpConnectivity(status({
      MCP_PLATFORM_USER_HEADER: 'X-Platform-User-Id',
      MCP_PLATFORM_USER_HEADER_ALIASES: ['x-wecom-user-id'],
    }));
    expect(wecomChannelEnabled(enabled)).toBe(true);
  });

  it('rejects credentials, query parameters, and non-HTTP schemes', () => {
    expect(validateExternalMcpUrl('https://user:secret@example.com/mcp').valid).toBe(false);
    expect(validateExternalMcpUrl('https://example.com/mcp?token=secret').valid).toBe(false);
    expect(validateExternalMcpUrl('file:///tmp/mcp').valid).toBe(false);
  });

  it('derives only the safe runtime configuration surface', () => {
    const secret = 'MCP_CLIENT_TOKEN_REAL_VALUE';
    const config = deriveMcpConnectivity(status({
      MCP_BIND_HOST: '127.0.0.1',
      MCP_PORT: 8080,
      MCP_PATH: '/mcp',
      MCP_AUTH_MODE: 'internal_bearer',
      MCP_ALLOWED_HOSTS: ['127.0.0.1:8080'],
      MCP_ALLOWED_ORIGINS: ['https://admin.example.com'],
      MCP_CLIENT_TOKEN: secret,
    }));

    expect(config.tokenConfigured).toBe(true);
    expect(JSON.stringify(config)).not.toContain(secret);
  });
});

function status(readOnlyRuntimeSettings: SystemStatusDto['readOnlyRuntimeSettings']): SystemStatusDto {
  return Object.freeze({
    adminVersion: '0.1.0-p5',
    mcpServerVersion: '0.1.0-p5',
    salesforceApiVersion: '65.0',
    providerVersions: Object.freeze([]),
    upstreamDrift: Object.freeze({ status: 'PASS', count: 0 }),
    database: Object.freeze({ status: 'UP', version: '8.0', schemaVersions: Object.freeze([]) }),
    runtimeMode: 'mysql',
    salesforceInstanceHost: 'example.my.salesforce.com',
    configured: Object.freeze({ connectedApp: true, jwtPrivateKey: true, mcpClientToken: true, identityCredentialEncryptionKey: true }),
    diagnostic: null,
    mcpHealth: 'UP',
    auditPersistence: Object.freeze({ status: 'UP', failureCount: 0 }),
    mcpEndpoint: 'http://127.0.0.1:8080/mcp',
    phases: Object.freeze({ P0: 'FINAL ACCEPTED', P1: 'FINAL ACCEPTED', P2: 'FINAL ACCEPTED', P3: 'FINAL ACCEPTED', P4: 'FINAL ACCEPTED', P5: 'FINAL ACCEPTED' }),
    readOnlyRuntimeSettings,
    buildPhase: 'P6-ID-01',
    capabilities: Object.freeze(['USER_BOUND_CREDENTIAL', 'IDENTITY_ROUTE_SEARCH', 'IDENTITY_ROUTE_PERMANENT_DELETE']),
  });
}
