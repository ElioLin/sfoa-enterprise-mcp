import type { SalesforceApiCategory } from './request-audit-collector.js';

export type SalesforceApiClassification = Readonly<{
  apiCategory: SalesforceApiCategory;
  apiVersion: string | null;
  requestUrl: string;
  host: string;
  endpointPath: string;
}>;

const SENSITIVE_QUERY_PARAMETERS = new Set([
  'access_token',
  'assertion',
  'client_secret',
  'private_key',
  'refresh_token',
  'session_id',
  'sid',
]);

export function classifySalesforceApiUrl(rawUrl: string): SalesforceApiClassification | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMETERS.has(key.toLowerCase())) url.searchParams.set(key, '[REDACTED]');
  }

  const pathname = url.pathname;
  const dataMatch = /^\/services\/data\/v([0-9]+(?:\.[0-9]+)?)(?:\/|$)/iu.exec(pathname);
  const soapMatch = /^\/services\/Soap\/([^/]+)\/([0-9]+(?:\.[0-9]+)?)(?:\/|$)/iu.exec(pathname);
  const apiVersion = dataMatch?.[1] ?? soapMatch?.[2] ?? null;

  return Object.freeze({
    apiCategory: classifyPath(pathname, dataMatch !== null, soapMatch?.[1]),
    apiVersion,
    requestUrl: url.toString(),
    host: url.host,
    endpointPath: `${url.pathname}${url.search}`,
  });
}

function classifyPath(
  pathname: string,
  isVersionedDataPath: boolean,
  soapService: string | undefined,
): SalesforceApiCategory {
  if (/^\/services\/oauth2(?:\/|$)/iu.test(pathname)) return 'OAUTH';
  if (/^\/services\/apexrest(?:\/|$)/iu.test(pathname)) return 'APEX_REST_API';
  if (soapService?.toLowerCase() === 'm') return 'METADATA_API';
  if (/^\/services\/Soap(?:\/|$)/iu.test(pathname)) return 'SOAP_API';
  if (!isVersionedDataPath) return 'UNKNOWN';
  if (/\/ui-api(?:\/|$)/iu.test(pathname)) return 'UI_API';
  if (/\/tooling(?:\/|$)/iu.test(pathname)) return 'TOOLING_API';
  if (/\/composite(?:\/|$)/iu.test(pathname)) return 'COMPOSITE_API';
  if (/\/jobs(?:\/|$)/iu.test(pathname)) return 'BULK_API';
  return 'REST_API';
}
