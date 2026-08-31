import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySalesforceApiUrl } from '../salesforce-api-classifier.js';

const cases = [
  ['https://login.salesforce.com/services/oauth2/token', 'OAUTH', null, '/services/oauth2/token'],
  ['https://acme.my.salesforce.com/services/data/v65.0/query?q=SELECT+Id+FROM+Account', 'REST_API', '65.0', '/services/data/v65.0/query?q=SELECT+Id+FROM+Account'],
  ['https://acme.my.salesforce.com/services/data/v64.0/ui-api/object-info/Lead', 'UI_API', '64.0', '/services/data/v64.0/ui-api/object-info/Lead'],
  ['https://acme.my.salesforce.com/services/data/v63.0/tooling/query?q=SELECT+Id+FROM+ApexClass', 'TOOLING_API', '63.0', '/services/data/v63.0/tooling/query?q=SELECT+Id+FROM+ApexClass'],
  ['https://acme.my.salesforce.com/services/data/v62.0/composite', 'COMPOSITE_API', '62.0', '/services/data/v62.0/composite'],
  ['https://acme.my.salesforce.com/services/data/v61.0/jobs/ingest', 'BULK_API', '61.0', '/services/data/v61.0/jobs/ingest'],
  ['https://acme.my.salesforce.com/services/apexrest/sfoa/health', 'APEX_REST_API', null, '/services/apexrest/sfoa/health'],
  ['https://acme.my.salesforce.com/services/Soap/m/65.0/00Dxx', 'METADATA_API', '65.0', '/services/Soap/m/65.0/00Dxx'],
  ['https://acme.my.salesforce.com/services/Soap/u/65.0/00Dxx', 'SOAP_API', '65.0', '/services/Soap/u/65.0/00Dxx'],
  ['https://acme.my.salesforce.com/services/unknown', 'UNKNOWN', null, '/services/unknown'],
] as const;

test('classifies Salesforce API URLs with deterministic host, path, and version facts', () => {
  for (const [url, category, version, endpointPath] of cases) {
    const result = classifySalesforceApiUrl(url);
    assert.ok(result, url);
    assert.equal(result.apiCategory, category, url);
    assert.equal(result.apiVersion, version, url);
    assert.equal(result.host, new URL(url).host, url);
    assert.equal(result.endpointPath, endpointPath, url);
  }
});

test('retains business query strings but excludes authentication material', () => {
  const result = classifySalesforceApiUrl(
    'https://login.salesforce.com/services/oauth2/token?q=SELECT+Id&assertion=secret-jwt&client_secret=secret',
  );
  assert.ok(result);
  assert.match(result.requestUrl, /q=SELECT\+Id/u);
  assert.doesNotMatch(result.requestUrl, /secret-jwt|client_secret=secret/u);
  assert.match(result.requestUrl, /assertion=%5BREDACTED%5D/u);
});

test('rejects non-absolute malformed URLs without guessing', () => {
  assert.equal(classifySalesforceApiUrl('/services/data/v65.0/query'), undefined);
  assert.equal(classifySalesforceApiUrl('not a url'), undefined);
});
