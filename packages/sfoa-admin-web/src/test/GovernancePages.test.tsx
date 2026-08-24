import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AuditPage from '../pages/AuditPage.js';
import DiagnosticPage from '../pages/DiagnosticPage.js';
import DmlPoliciesPage from '../pages/DmlPoliciesPage.js';
import IdentityRoutesPage from '../pages/IdentityRoutesPage.js';
import SystemPage from '../pages/SystemPage.js';
import ToolGovernancePage from '../pages/ToolGovernancePage.js';
import { apiError, asFetchMock, jsonResponse, renderAdmin } from './helpers.js';

const NOW = '2026-08-23T12:00:00.000Z';

describe('Admin governance pages', () => {
  it('creates an identity route through the shared API client', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/routes') && init.method === 'POST') return jsonResponse(routeRecord());
      return jsonResponse(page([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<IdentityRoutesPage />);

    await user.click(await screen.findByRole('button', { name: 'Create route' }));
    await user.type(screen.getByLabelText('Platform user ID'), 'platform-a');
    await user.type(screen.getByLabelText('Salesforce username'), 'sf-user@example.com');
    await user.type(screen.getByLabelText('Remark'), 'production route');
    await user.click(screen.getByRole('button', { name: 'Save route' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/routes') && init?.method === 'POST')).toBe(true));
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/routes') && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({ platformUserId: 'platform-a', salesforceUsername: 'sf-user@example.com', enabled: true });
  });

  it('renders an unknown executable control as impossible to enable', async () => {
    vi.stubGlobal('fetch', asFetchMock(() => jsonResponse({
      items: [{
        toolName: 'future_unknown_tool', classification: 'UNKNOWN', executionRole: 'USER', remoteCompatible: false,
        releaseState: 'UNKNOWN', enabled: false, rowVersion: '1', remark: null, dependencies: [], status: 'UNKNOWN',
        enableAllowed: false, disabledReason: 'Unknown executable catalog entry.',
      }],
      controlsTruncated: false,
    })));
    renderAdmin(<ToolGovernancePage />);

    const toggle = await screen.findByRole('switch', { name: 'Enable future_unknown_tool' });
    expect(toggle).toBeDisabled();
    expect(screen.getByText('Unknown executable catalog entry.')).toBeInTheDocument();
  });

  it('saves independent CREATE and UPDATE policy toggles', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/dml-policies') && init.method === 'POST') return jsonResponse(policyRecord());
      return jsonResponse(page([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<DmlPoliciesPage />);

    await user.click(await screen.findByRole('button', { name: 'Add object policy' }));
    await user.type(screen.getByLabelText('Object API name'), 'Lead');
    const dialog = screen.getByRole('dialog');
    const toggles = within(dialog).getAllByRole('switch');
    expect(toggles).toHaveLength(3);
    await user.click(toggles[0]!);
    await user.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/dml-policies') && init?.method === 'POST')).toBe(true));
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/dml-policies') && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ objectApiName: 'Lead', allowCreate: true, allowUpdate: false, enabled: true, remark: null });
  });

  it('shows the real diagnostic verification state and bounded evidence', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (url.pathname.endsWith('/diagnostic/verify') && init.method === 'POST') return jsonResponse({ config: diagnosticConfig(), verification: diagnosticVerification() });
      return jsonResponse({ config: diagnosticConfig(), configured: { connectedApp: true, jwtPrivateKey: true } });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<DiagnosticPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Verify Diagnostic Connection' }));
    expect(await screen.findByText('Latest verification evidence')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    expect(screen.getByText('1/1 cleaned; 0 active')).toBeInTheDocument();
  });

  it('requests the next bounded audit page from the server', async () => {
    const fetchMock = asFetchMock((url) => {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const rows = Array.from({ length: 25 }, (_value, index) => auditRecord(String(offset + index + 1)));
      return jsonResponse({ ...page(rows), offset, hasMore: offset === 0, nextOffset: offset === 0 ? 25 : null });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAdmin(<AuditPage />);

    await screen.findByText('correlation-1');
    fireEvent.click(screen.getByTitle('Next Page'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('offset=25'))).toBe(true));
    expect(await screen.findByText('correlation-26')).toBeInTheDocument();
  });

  it('turns HTTP 409 into actionable version-conflict feedback', async () => {
    const fetchMock = asFetchMock((url, init) => {
      if (/\/routes\/1$/u.test(url.pathname) && init.method === 'PUT') return apiError(409, 'MCP_ADMIN_CONCURRENT_MODIFICATION', 'Conflict.');
      return jsonResponse(page([routeRecord()]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAdmin(<IdentityRoutesPage />);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save route' }));
    expect(await screen.findByText('Configuration changed')).toBeInTheDocument();
    expect(screen.getByText(/Another administrator changed this row/u)).toBeInTheDocument();
  });

  it('renders only configured state even when an unexpected secret-shaped field exists', async () => {
    const secret = 'SHOULD_NEVER_RENDER_PRIVATE_KEY';
    const fetchMock = asFetchMock((url) => url.pathname.endsWith('/system/settings')
      ? jsonResponse([])
      : jsonResponse({ ...systemStatus(), unexpectedSecret: secret, configured: { connectedApp: true, jwtPrivateKey: true, mcpClientToken: true, raw: secret } }));
    vi.stubGlobal('fetch', fetchMock);
    const rendered = renderAdmin(<SystemPage />);

    await screen.findByText('Credential readiness', { exact: false });
    expect(rendered.container).not.toHaveTextContent(secret);
    expect(screen.getAllByText('CONFIGURED')).toHaveLength(3);
  });
});

function page<T>(items: readonly T[]) {
  return { items, limit: 25, offset: 0, count: items.length, hasMore: false, nextOffset: null };
}

function routeRecord() {
  return { id: '1', platformUserId: 'platform-a', salesforceUsername: 'sf-user@example.com', enabled: true, remark: 'production route', rowVersion: '1', createdAt: NOW, updatedAt: NOW };
}

function policyRecord() {
  return { id: '1', objectApiName: 'Lead', allowCreate: true, allowUpdate: false, enabled: true, remark: null, rowVersion: '1', createdAt: NOW, updatedAt: NOW };
}

function diagnosticConfig() {
  return { id: '1', salesforceUsername: 'diagnostic@example.com', enabled: true, verificationStatus: 'NOT_VERIFIED', lastVerifiedAt: null, lastErrorCode: null, lastErrorMessageSafe: null, testMetadataType: 'CustomObject', testMetadataFullName: 'Account', rowVersion: '1', createdAt: NOW, updatedAt: NOW };
}

function diagnosticVerification() {
  return {
    status: 'PASS', identityMatched: true, salesforceUsername: 'diagnostic@example.com', apiVersion: '65.0', durationMs: 120,
    tooling: { totalSize: 2, returnedRecords: 2, truncated: false },
    metadata: { status: 'PASS', metadataType: 'CustomObject', fullName: 'Account', totalFiles: 1, returnedFiles: 1, returnedBytes: 128, truncated: false },
    cleanup: { created: 1, cleaned: 1, active: 0, pass: true }, error: null,
  };
}

function auditRecord(id: string) {
  return {
    id, occurredAt: NOW, correlationId: `correlation-${id}`, channel: 'MCP', clientId: 'client-a', actorAdmin: null,
    platformUserId: 'platform-a', salesforceUsername: 'sf-user@example.com', executionRole: 'USER', toolName: 'run_soql_query',
    operation: 'READ', objectApiName: null, recordId: null, result: 'PASS', outcome: 'SUCCESS', errorCode: null, durationMs: 5,
    requestSummary: { querySha256: 'abcd', queryLength: 42 }, responseSummary: { returnedRecords: 1 }, createdAt: NOW,
  };
}

function systemStatus() {
  return {
    adminVersion: '0.1.0-p5', mcpServerVersion: '0.1.0-p5', salesforceApiVersion: '65.0', providerVersions: [{ name: 'salesforce', version: '1.2.3' }],
    upstreamDrift: { status: 'PASS', count: 0 }, database: { status: 'UP', version: '8.0.44', schemaVersions: ['001', '002'] },
    runtimeMode: 'mysql', salesforceInstanceHost: 'example.my.salesforce.com', configured: { connectedApp: true, jwtPrivateKey: true, mcpClientToken: true },
    diagnostic: diagnosticConfig(), mcpHealth: 'UP', auditPersistence: { status: 'UP', failureCount: 0 }, mcpEndpoint: 'http://127.0.0.1:8080/mcp',
    phases: { P0: 'FINAL ACCEPTED', P1: 'FINAL ACCEPTED', P2: 'FINAL ACCEPTED', P3: 'FINAL ACCEPTED', P4: 'PARTIAL', P5: 'PARTIAL' },
    readOnlyRuntimeSettings: { MCP_BIND_HOST: '127.0.0.1', MCP_AUTH_MODE: 'bearer' },
  };
}
