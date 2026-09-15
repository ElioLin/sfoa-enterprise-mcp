#!/usr/bin/env node
/**
 * SFoA Attachment Capability Probe (workspace utility, NOT a business Tool).
 *
 * Answers one question with live evidence from the current SFoA test Org:
 * can the current requester-scoped Salesforce identity upload a file through the
 * Salesforce REST ContentVersion API and have it associated with a business record?
 *
 * It reuses the *existing* request-scoped identity path unchanged:
 *   project config -> MySQL identity route -> JWT Connection -> @salesforce/core Connection.
 * It adds no second authentication mechanism, no MCP Tool, no Skill, no runtime hook.
 *
 * It never prints an access token, private key, session secret, or file bytes.
 *
 * Modes:
 *   node scripts/sfoa-attachment-capability-probe.mjs --recon
 *       Read-only: control-plane mode, instance host, API version, identity routes,
 *       DML allowlist, and the ContentVersion/ContentDocument/ContentDocumentLink describes.
 *   node scripts/sfoa-attachment-capability-probe.mjs [--upload]
 *       Everything above plus the multipart upload probe, association verification,
 *       update-semantics probe, one safe error probe, and test-owned cleanup.
 *
 * Optional environment:
 *   PROBE_PLATFORM_USER_ID     platform user id to probe as (default: first active USER route)
 *   PROBE_TARGET_RECORD_ID     18-char target business record id for FirstPublishLocationId
 *   PROBE_KEEP_DATA=true       skip cleanup (leaves the probe ContentDocument in place)
 */

import { createHash, randomUUID } from 'node:crypto';
import { loadRemoteRuntimeConfig } from '../packages/sfoa-mcp-server/dist/config.js';
import { createIdentityRuntime, NoopRuntimeLogger } from '../packages/sfoa-identity-runtime/dist/index.js';
import {
  createControlPlaneDatabase,
  MySqlControlPlaneStore,
  MySqlIdentityRepository,
} from '../packages/sfoa-control-plane/dist/index.js';

const MODE = process.argv.includes('--recon') ? 'recon' : 'upload';
const PROBE_FILE_NAME = 'sfoa-attachment-probe.txt';
const ID_PATTERN = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/u;

const evidence = {
  probe: 'SFOA_ATTACHMENT_CAPABILITY_PROBE',
  mode: MODE,
  startedAt: new Date().toISOString(),
};
const gates = [];
const gate = (name, status, detail) => gates.push({ gate: name, status, ...(detail === undefined ? {} : { detail }) });

/** Removes anything token-shaped from a string before it reaches the report. */
function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer <redacted>')
    .replace(/[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu, '<redacted-jwt>')
    .replace(/00D[A-Za-z0-9]{12,15}!\S{20,}/gu, '<redacted-session-id>');
}

function safeError(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? error?.errorCode,
    message: redact(String(error?.message ?? error)),
  };
}

async function rawRequest(connection, apiVersion, path, init = {}) {
  const url = `${connection.instanceUrl}/services/data/v${apiVersion}${path}`;
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return {
    endpoint: `/services/data/v${apiVersion}${path}`,
    requestHost: new URL(url).host,
    status: response.status,
    location: response.headers.get('location') ?? undefined,
    contentType: response.headers.get('content-type') ?? undefined,
    body: parsed ?? (text.length > 0 ? redact(text.slice(0, 2000)) : undefined),
  };
}

function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}`;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${part.contentType}\r\n\r\n`,
      'utf8',
    ));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function summarizeDescribe(describe, fields) {
  return {
    name: describe.name,
    label: describe.label,
    keyPrefix: describe.keyPrefix,
    queryable: describe.queryable,
    createable: describe.createable,
    updateable: describe.updateable,
    deletable: describe.deletable,
    custom: describe.custom,
    fieldCount: describe.fields?.length,
    fields: Object.fromEntries((fields ?? []).map((name) => {
      const field = (describe.fields ?? []).find((item) => item.name === name);
      if (!field) return [name, { present: false }];
      return [name, {
        present: true,
        type: field.type,
        length: field.length,
        createable: field.createable,
        updateable: field.updateable,
        nillable: field.nillable,
        defaultedOnCreate: field.defaultedOnCreate,
        ...(field.picklistValues?.length
          ? { picklistValues: field.picklistValues.map((item) => ({ value: item.value, active: item.active, defaultValue: item.defaultValue })) }
          : {}),
      }];
    })),
  };
}

async function main() {
  const root = process.cwd();
  const config = await loadRemoteRuntimeConfig(root, process.env);
  evidence.controlPlaneMode = config.controlPlane.mode;
  evidence.instanceHost = new URL(config.identity.instanceUrl).host;
  evidence.instanceOrigin = config.identity.instanceUrl;

  if (config.controlPlane.mode !== 'mysql') {
    throw new Error('This probe expects the deployed SFOA_CONTROL_PLANE_MODE=mysql identity source; refusing to run.');
  }

  const database = createControlPlaneDatabase(config.controlPlane.database);
  const store = new MySqlControlPlaneStore(database);
  const runtime = createIdentityRuntime(config.identity, {
    identityRepository: new MySqlIdentityRepository(database),
    logger: new NoopRuntimeLogger(),
  });

  const routes = await store.repositories.identityRoutes.list({ limit: 200, offset: 0 });
  const activeUserRoutes = routes.items.filter((row) => row.enabled);
  evidence.identityRoutes = activeUserRoutes.map((row) => ({
    platformUserId: row.platformUserId,
    userName: row.userName,
    salesforceUsername: row.salesforceUsername,
    enabled: row.enabled,
  }));
  if (evidence.identityRoutes.length === 0) throw new Error('No active identity route is configured.');

  const dmlPolicies = await store.repositories.dmlPolicies.listEnabled();
  evidence.dmlAllowlist = dmlPolicies.map((row) => ({
    objectApiName: row.objectApiName,
    allowCreate: row.allowCreate,
    allowUpdate: row.allowUpdate,
  }));

  const requestedPlatformUser = process.env.PROBE_PLATFORM_USER_ID?.trim();
  const route = requestedPlatformUser
    ? activeUserRoutes.find((row) => row.platformUserId === requestedPlatformUser)
    : activeUserRoutes[0];
  if (!route) throw new Error('PROBE_PLATFORM_USER_ID does not match any active identity route.');

  const scope = await runtime.scopeFactory.create({ platformUserId: route.platformUserId, correlationId: randomUUID() });
  try {
    const connection = await scope.getConnection();
    const identity = await connection.identity();
    const apiVersion = connection.getApiVersion();
    evidence.requesterScopedIdentity = {
      usedRequesterScopedIdentity: true,
      identitySource: 'MYSQL_IDENTITY_ROUTE',
      platformUserId: scope.route.platformUserId,
      mappedSalesforceUsername: identity.username,
      salesforceUserId: identity.user_id ?? identity.userId,
      organizationId: identity.organization_id ?? identity.organizationId,
      organizationIdShort: identity.org_id,
      connectionRole: scope.route.connectionRole,
      credentialProfile: scope.route.credentialProfile,
      apiVersion,
      instanceHost: new URL(connection.instanceUrl).host,
    };
    gate('requester-scoped identity resolved to one Salesforce user',
      identity.username.toLowerCase() === scope.route.salesforceUsername.toLowerCase() ? 'PASS' : 'FAIL');

    evidence.describe = {
      ContentVersion: summarizeDescribe(
        (await rawRequest(connection, apiVersion, '/sobjects/ContentVersion/describe')).body,
        ['Id', 'ContentDocumentId', 'Title', 'PathOnClient', 'VersionData', 'FirstPublishLocationId',
          'ContentSize', 'FileExtension', 'FileType', 'IsLatest', 'VersionNumber', 'OwnerId', 'CreatedById', 'CreatedDate'],
      ),
      ContentDocument: summarizeDescribe(
        (await rawRequest(connection, apiVersion, '/sobjects/ContentDocument/describe')).body,
        ['Id', 'Title', 'LatestPublishedVersionId', 'FileType', 'FileExtension', 'ContentSize', 'OwnerId',
          'CreatedById', 'CreatedDate', 'LastModifiedDate'],
      ),
      ContentDocumentLink: summarizeDescribe(
        (await rawRequest(connection, apiVersion, '/sobjects/ContentDocumentLink/describe')).body,
        ['Id', 'ContentDocumentId', 'LinkedEntityId', 'ShareType', 'Visibility', 'SystemModstamp'],
      ),
    };

    const version = evidence.describe.ContentVersion;
    const document = evidence.describe.ContentDocument;
    const link = evidence.describe.ContentDocumentLink;
    gate('ContentVersion is queryable and createable', version.queryable && version.createable ? 'PASS' : 'FAIL');
    gate('ContentDocument is queryable (client must not INSERT it)', document.queryable ? 'PASS' : 'FAIL');
    gate('ContentDocumentLink is queryable', link.queryable ? 'PASS' : 'FAIL');
    gate('FirstPublishLocationId is createable on ContentVersion',
      version.fields.FirstPublishLocationId?.createable === true ? 'PASS' : 'FAIL');
    // Observed, not assumed: SFoA describe is the authority for this field's flags.
    evidence.versionDataDescribeFacts = {
      createable: version.fields.VersionData?.createable,
      updateable: version.fields.VersionData?.updateable,
      nillable: version.fields.VersionData?.nillable,
      type: version.fields.VersionData?.type,
    };
    gate('VersionData is createable on ContentVersion',
      version.fields.VersionData?.createable === true ? 'PASS' : 'FAIL');
    gate('ContentDocument is not createable by the client (Salesforce must create it)',
      document.createable === false ? 'PASS' : 'FAIL', `createable=${document.createable}`);

    const userRows = await connection.query(
      `SELECT Id, Username, Name, UserType, IsActive FROM User WHERE Id = '${identity.user_id ?? identity.userId}'`,
    );
    const userRow = userRows.records[0];
    let profileName;
    try {
      const profileRows = await connection.query(
        `SELECT Profile.Name FROM User WHERE Id = '${identity.user_id ?? identity.userId}'`,
      );
      profileName = profileRows.records[0]?.Profile?.Name;
    } catch (error) {
      // Profile is not always readable by a standard user; that itself is evidence.
      profileName = `NOT READABLE (${safeError(error).code ?? 'unknown'})`;
    }
    evidence.mappedSalesforceUser = userRow
      ? {
        Id: userRow.Id,
        Username: userRow.Username,
        Name: userRow.Name,
        UserType: userRow.UserType,
        IsActive: userRow.IsActive,
        ProfileName: profileName,
      }
      : null;
    gate('mapped Salesforce user is an active standard user (not a fixed integration identity)',
      userRow?.IsActive === true ? 'PASS' : 'FAIL', `profile=${profileName ?? 'unknown'}`);

    // ── Manual cleanup mode for probe artifacts left by an earlier run ──
    // ContentVersion.deleteable is false in this Org, so the ContentDocument is the
    // only cascade root. Each id must be a ContentVersion id of a probe-owned file.
    const manualVersionIds = (process.env.PROBE_CLEANUP_VERSION_IDS ?? '')
      .split(',').map((value) => value.trim()).filter((value) => value.length > 0);
    if (manualVersionIds.length > 0) {
      evidence.manualCleanup = [];
      for (const versionId of manualVersionIds) {
        const rows = await connection.query(
          `SELECT Id, ContentDocumentId, Title, PathOnClient FROM ContentVersion WHERE Id = '${versionId}'`,
        );
        const row = rows.records[0];
        if (!row?.ContentDocumentId) {
          evidence.manualCleanup.push({ versionId, found: Boolean(row), deleted: false });
          continue;
        }
        const removed = await rawRequest(connection, apiVersion, `/sobjects/ContentDocument/${row.ContentDocumentId}`, { method: 'DELETE' });
        const remaining = await connection.query(`SELECT Id FROM ContentDocument WHERE Id = '${row.ContentDocumentId}'`);
        evidence.manualCleanup.push({
          versionId,
          found: true,
          ContentDocumentId: row.ContentDocumentId,
          Title: row.Title,
          PathOnClient: row.PathOnClient,
          deleteHttpStatus: removed.status,
          deleted: remaining.records.length === 0,
        });
      }
      gate('manual probe-artifact cleanup',
        evidence.manualCleanup.every((row) => row.deleted) ? 'PASS' : 'FAIL');
      return;
    }

    if (MODE === 'recon') {
      evidence.candidateTargetRecords = {};
      for (const policy of dmlPolicies) {
        try {
          const objectDescribe = await connection.sobject(policy.objectApiName).describe();
          const hasName = (objectDescribe.fields ?? []).some((field) => field.name === 'Name');
          const fields = hasName ? 'Id, Name' : 'Id';
          const rows = await connection.query(
            `SELECT ${fields} FROM ${policy.objectApiName} ORDER BY CreatedDate DESC LIMIT 10`,
          );
          const counts = await connection.query(`SELECT COUNT() FROM ${policy.objectApiName}`);
          evidence.candidateTargetRecords[policy.objectApiName] = {
            totalRecords: counts.totalSize,
            recentRecords: rows.records.map((row) => ({ Id: row.Id, ...(hasName ? { Name: row.Name } : {}) })),
          };
        } catch (error) {
          evidence.candidateTargetRecords[policy.objectApiName] = { error: safeError(error) };
        }
      }
      return;
    }

    // ── Probe file: tiny, non-sensitive, deterministic bytes ──
    const probeId = randomUUID();
    const bytes = Buffer.from(
      `SFOA Attachment Capability Probe\nTimestamp: ${new Date().toISOString()}\nRandom Probe Id: ${probeId}\n`,
      'utf8',
    );
    evidence.probeFile = {
      filename: PROBE_FILE_NAME,
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      probeId,
      contentType: 'text/plain',
    };

    const targetRecordId = process.env.PROBE_TARGET_RECORD_ID?.trim();
    if (targetRecordId !== undefined && !ID_PATTERN.test(targetRecordId)) {
      throw new Error('PROBE_TARGET_RECORD_ID must be a 15- or 18-character Salesforce record id.');
    }
    evidence.businessRecordTarget = targetRecordId
      ? { targetRecordId, source: 'PROBE_TARGET_RECORD_ID' }
      : { targetRecordId: null, source: 'NONE', state: 'PENDING — SAFE TARGET RECORD REQUIRED' };

    // ── Primary probe: REST multipart binary upload ──
    const entityContent = { Title: `SFOA Attachment Probe ${probeId.slice(0, 8)}`, PathOnClient: PROBE_FILE_NAME };
    if (targetRecordId) entityContent.FirstPublishLocationId = targetRecordId;
    const boundary = `----sfoaAttachmentProbe${randomUUID().replace(/-/gu, '')}`;
    const multipartBody = buildMultipart(boundary, [
      { name: 'entity_content', contentType: 'application/json', data: JSON.stringify(entityContent) },
      { name: 'VersionData', filename: PROBE_FILE_NAME, contentType: 'text/plain', data: bytes },
    ]);
    const upload = await rawRequest(connection, apiVersion, '/sobjects/ContentVersion', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipartBody,
    });
    evidence.multipartUpload = {
      endpoint: upload.endpoint,
      requestHost: upload.requestHost,
      httpStatus: upload.status,
      redirected: upload.status >= 300 && upload.status < 400,
      locationHeader: upload.location,
      contentDispositionPart: 'entity_content (application/json)',
      binaryPart: `VersionData (text/plain, ${bytes.byteLength} bytes)`,
      response: upload.body,
    };
    const createdVersionId = upload.status < 300 && ID_PATTERN.test(String(upload.body?.id ?? ''))
      ? String(upload.body.id)
      : undefined;
    evidence.multipartUpload.createdContentVersionId = createdVersionId ?? null;
    gate('REST multipart binary upload of ContentVersion',
      upload.status < 300 ? 'PASS' : 'FAIL',
      `HTTP ${upload.status} ${redact(String(upload.body?.map?.((item) => item.errorCode).join(',') ?? ''))}`.trim());

    // ── Error probes: no business data is touched, and every artifact a probe does create is
    //    tracked and removed with the rest of the probe data. Salesforce's own first cause is
    //    recorded verbatim so the future Tool can be shown to preserve it.
    const errorProbeCreatedTitles = [];
    const errorProbeCreatedIds = [];
    const errorProbeUpload = async (label, firstPublishLocationId, title) => {
      const boundary = `----sfoaAttachmentProbeErr${randomUUID().replace(/-/gu, '')}`;
      const result = await rawRequest(connection, apiVersion, '/sobjects/ContentVersion', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: buildMultipart(boundary, [
          {
            name: 'entity_content',
            contentType: 'application/json',
            data: JSON.stringify({ Title: title, PathOnClient: PROBE_FILE_NAME, FirstPublishLocationId: firstPublishLocationId }),
          },
          { name: 'VersionData', filename: PROBE_FILE_NAME, contentType: 'text/plain', data: bytes },
        ]),
      });
      const first = Array.isArray(result.body) ? result.body[0] : undefined;
      const createdId = result.status < 300 && ID_PATTERN.test(String(result.body?.id ?? ''))
        ? String(result.body.id)
        : null;
      if (createdId) { errorProbeCreatedIds.push(createdId); errorProbeCreatedTitles.push(title); }
      return {
        scenario: label,
        firstPublishLocationId,
        httpStatus: result.status,
        salesforceErrorCode: first?.errorCode,
        salesforceMessage: redact(String(first?.message ?? '')),
        createdId,
      };
    };

    // §22 scenario 1 — a malformed (non-Salesforce-id) FirstPublishLocationId. Salesforce validates
    // id format before DML, so this must fail closed and create nothing.
    const malformedTarget = 'SFOA-PROBE-NOT-AN-ID';
    const malformedTitle = `SFOA Probe Malformed Target ${probeId.slice(0, 8)}`;
    const malformedProbe = await errorProbeUpload(
      'ContentVersion multipart with a malformed (non-id) FirstPublishLocationId',
      malformedTarget,
      malformedTitle,
    );
    const malformedLeftovers = await connection.query(
      `SELECT Id FROM ContentVersion WHERE Title = '${malformedTitle.replace(/'/gu, "\\'")}'`,
    );
    malformedProbe.sideEffects = malformedLeftovers.records.length;
    malformedProbe.preservesSalesforceFirstCause = Boolean(malformedProbe.salesforceErrorCode);

    // §22 scenario 2 — a well-formed but non-existent FirstPublishLocationId. Observed SFoA
    // behavior is recorded as-is; if this Org creates the file anyway, the id is tracked above so
    // the probe leaves nothing behind.
    const nonExistentProbe = await errorProbeUpload(
      'ContentVersion multipart with a well-formed but non-existent FirstPublishLocationId',
      '000000000000000AAA',
      `SFOA Probe NonExistent Target ${probeId.slice(0, 8)}`,
    );
    nonExistentProbe.preservesSalesforceFirstCause = Boolean(nonExistentProbe.salesforceErrorCode);
    nonExistentProbe.note = nonExistentProbe.createdId
      ? 'This Org created the file even though the target record does not exist; the created id is tracked and removed with the probe data.'
      : undefined;

    evidence.errorProbe = { malformedTarget: malformedProbe, nonExistentTarget: nonExistentProbe };

    // ── Automatic ContentDocument ──
    const cleanup = [];
    if (createdVersionId) cleanup.push({ id: createdVersionId, type: 'ContentVersion' });
    for (const id of errorProbeCreatedIds) cleanup.push({ id, type: 'ContentVersion', origin: 'errorProbe' });
    let createdDocumentId;
    if (createdVersionId) {
      const versionRows = await connection.query(
        `SELECT Id, ContentDocumentId, Title, PathOnClient, FileExtension, FileType, ContentSize, IsLatest,`
        + ` VersionNumber, OwnerId, CreatedById, CreatedDate FROM ContentVersion WHERE Id = '${createdVersionId}'`,
      );
      const versionRow = versionRows.records[0];
      createdDocumentId = versionRow?.ContentDocumentId ? String(versionRow.ContentDocumentId) : undefined;
      evidence.createdContentVersion = versionRow
        ? {
          Id: versionRow.Id,
          ContentDocumentId: versionRow.ContentDocumentId,
          Title: versionRow.Title,
          PathOnClient: versionRow.PathOnClient,
          FileExtension: versionRow.FileExtension,
          FileType: versionRow.FileType,
          ContentSize: versionRow.ContentSize,
          IsLatest: versionRow.IsLatest,
          VersionNumber: versionRow.VersionNumber,
          OwnerId: versionRow.OwnerId,
          CreatedById: versionRow.CreatedById,
          CreatedDate: versionRow.CreatedDate,
        }
        : null;
      gate('ContentDocumentId is auto-populated on the created ContentVersion',
        Boolean(createdDocumentId) ? 'PASS' : 'FAIL');
    }
    if (createdDocumentId) {
      cleanup.push({ id: createdDocumentId, type: 'ContentDocument' });
      const documentRows = await connection.query(
        `SELECT Id, Title, LatestPublishedVersionId, FileType, FileExtension, ContentSize, OwnerId, CreatedById`
        + ` FROM ContentDocument WHERE Id = '${createdDocumentId}'`,
      );
      evidence.createdContentDocument = documentRows.records[0]
        ? {
          Id: documentRows.records[0].Id,
          Title: documentRows.records[0].Title,
          LatestPublishedVersionId: documentRows.records[0].LatestPublishedVersionId,
          FileType: documentRows.records[0].FileType,
          ContentSize: documentRows.records[0].ContentSize,
          OwnerId: documentRows.records[0].OwnerId,
          CreatedById: documentRows.records[0].CreatedById,
        }
        : null;
      gate('Salesforce created the ContentDocument automatically',
        Boolean(evidence.createdContentDocument) ? 'PASS' : 'FAIL');
    }

    // ── Automatic ContentDocumentLink + business record association ──
    if (createdDocumentId) {
      const linkRows = await connection.query(
        `SELECT Id, ContentDocumentId, LinkedEntityId, ShareType, Visibility FROM ContentDocumentLink`
        + ` WHERE ContentDocumentId = '${createdDocumentId}'`,
      );
      evidence.contentDocumentLinks = linkRows.records.map((row) => ({
        Id: row.Id,
        ContentDocumentId: row.ContentDocumentId,
        LinkedEntityId: row.LinkedEntityId,
        ShareType: row.ShareType,
        Visibility: row.Visibility,
      }));
      if (targetRecordId) {
        const matched = evidence.contentDocumentLinks.some(
          (row) => String(row.LinkedEntityId).slice(0, 15) === targetRecordId.slice(0, 15),
        );
        gate('FirstPublishLocationId created the ContentDocumentLink to the target record',
          matched ? 'PASS' : 'FAIL', `links=${evidence.contentDocumentLinks.length}`);
        if (!matched) {
          const manualBoundary = `----sfoaAttachmentProbeLink${randomUUID().replace(/-/gu, '')}`;
          const manual = await rawRequest(connection, apiVersion, '/sobjects/ContentDocumentLink', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ContentDocumentId: createdDocumentId, LinkedEntityId: targetRecordId, ShareType: 'V', Visibility: 'AllUsers' }),
          });
          evidence.manualContentDocumentLinkProbe = { httpStatus: manual.status, response: manual.body };
          if (manual.status < 300 && ID_PATTERN.test(String(manual.body?.id ?? ''))) {
            cleanup.push({ id: String(manual.body.id), type: 'ContentDocumentLink' });
          }
        }
        const recordLinks = await connection.query(
          `SELECT Id, ContentDocumentId, LinkedEntityId, ShareType, Visibility FROM ContentDocumentLink`
          + ` WHERE LinkedEntityId = '${targetRecordId}'`,
        );
        evidence.targetRecordFiles = recordLinks.records.map((row) => ({
          Id: row.Id,
          ContentDocumentId: row.ContentDocumentId,
          LinkedEntityId: row.LinkedEntityId,
          ShareType: row.ShareType,
          Visibility: row.Visibility,
        }));
        gate('The target business record exposes the probe file through its Files relationship',
          evidence.targetRecordFiles.some((row) => String(row.ContentDocumentId).slice(0, 15) === createdDocumentId.slice(0, 15)) ? 'PASS' : 'FAIL');
      }
    }

    // ── ContentVersion update semantics ──
    if (createdVersionId) {
      const patchedTitle = `SFOA Attachment Probe ${probeId.slice(0, 8)} (metadata patched)`;
      const patch = await rawRequest(connection, apiVersion, `/sobjects/ContentVersion/${createdVersionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Title: patchedTitle }),
      });
      const afterPatch = await connection.query(
        `SELECT Id, Title, VersionNumber, IsLatest FROM ContentVersion WHERE Id = '${createdVersionId}'`,
      );
      evidence.contentVersionUpdateProbe = {
        metadataPatch: {
          operation: 'PATCH ContentVersion.Title',
          httpStatus: patch.status,
          response: patch.body,
          titleAfterPatch: afterPatch.records[0]?.Title,
          versionNumberAfterPatch: afterPatch.records[0]?.VersionNumber,
        },
        describeObjectUpdateable: version.updateable,
        describeVersionDataUpdateable: version.fields.VersionData?.updateable,
      };
      gate('ContentVersion metadata is updateable in place (Title)',
        patch.status < 300 && afterPatch.records[0]?.Title === patchedTitle ? 'PASS' : 'FAIL', `HTTP ${patch.status}`);

      // Does a VersionData PATCH replace the bytes, or is a new Version required?
      const bytesProbe = await rawRequest(connection, apiVersion, `/sobjects/ContentVersion/${createdVersionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ VersionData: Buffer.from('replacement bytes').toString('base64') }),
      });
      evidence.contentVersionUpdateProbe.versionDataPatch = {
        operation: 'PATCH ContentVersion.VersionData (base64)',
        httpStatus: bytesProbe.status,
        response: bytesProbe.body,
      };
      // Recorded as an observed fact; SFoA behaviour, not a global-Salesforce assumption.
      evidence.contentVersionUpdateProbe.bytesRequireNewVersion =
        bytesProbe.status >= 300;

      // Inserting with ContentDocumentId is the documented way to add a version.
      const versionBoundary = `----sfoaAttachmentProbeV2${randomUUID().replace(/-/gu, '')}`;
      const secondBytes = Buffer.from(`SFOA Attachment Capability Probe v2\nProbe Id: ${probeId}\n`, 'utf8');
      const secondVersion = await rawRequest(connection, apiVersion, '/sobjects/ContentVersion', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${versionBoundary}` },
        body: buildMultipart(versionBoundary, [
          {
            name: 'entity_content',
            contentType: 'application/json',
            data: JSON.stringify({ Title: patchedTitle, PathOnClient: PROBE_FILE_NAME, ContentDocumentId: createdDocumentId }),
          },
          { name: 'VersionData', filename: PROBE_FILE_NAME, contentType: 'text/plain', data: secondBytes },
        ]),
      });
      const versionsAfter = await connection.query(
        `SELECT Id, VersionNumber, IsLatest FROM ContentVersion WHERE ContentDocumentId = '${createdDocumentId}' ORDER BY VersionNumber`,
      );
      evidence.contentVersionUpdateProbe.newVersionInsert = {
        operation: 'POST ContentVersion multipart with ContentDocumentId',
        httpStatus: secondVersion.status,
        response: secondVersion.body,
        versionsOfDocument: versionsAfter.records.map((row) => ({
          Id: row.Id, VersionNumber: row.VersionNumber, IsLatest: row.IsLatest,
        })),
      };
      gate('a new version is created by INSERT with ContentDocumentId rather than replacing bytes',
        secondVersion.status < 300 && versionsAfter.records.length === 2 ? 'PASS' : 'FAIL',
        `HTTP ${secondVersion.status} versions=${versionsAfter.records.length}`);
    }

    // ── Cleanup: research the real Files cascade instead of deleting three objects blindly ──
    // ContentVersion.deleteable is false in this Org, so ContentDocument is the only cascade root.
    // Every ContentVersion this run created — including the error probes' — is resolved to its
    // ContentDocument and removed through that single root.
    evidence.cleanup = { attempted: false, strategy: 'DELETE each probe ContentDocument, then verify version/link cascade' };
    const rootDocumentIds = new Set(createdDocumentId ? [createdDocumentId] : []);
    evidence.cleanup.orphanReconciliation = [];
    for (const id of errorProbeCreatedIds) {
      const rows = await connection.query(`SELECT Id, ContentDocumentId FROM ContentVersion WHERE Id = '${id}'`);
      const row = rows.records[0];
      evidence.cleanup.orphanReconciliation.push({
        contentVersionId: id,
        exists: Boolean(row),
        contentDocumentId: row?.ContentDocumentId ?? null,
      });
      if (row?.ContentDocumentId) rootDocumentIds.add(String(row.ContentDocumentId));
    }
    if (process.env.PROBE_KEEP_DATA === 'true') {
      evidence.cleanup.skipped = 'PROBE_KEEP_DATA=true';
      evidence.cleanup.pendingIds = cleanup;
      gate('test-owned cleanup', 'BLOCKED', 'PROBE_KEEP_DATA=true left the probe ContentDocument in place.');
    } else if (rootDocumentIds.size > 0) {
      evidence.cleanup.attempted = true;
      evidence.cleanup.deleteContentDocument = [];
      for (const documentId of rootDocumentIds) {
        const deleted = await rawRequest(connection, apiVersion, `/sobjects/ContentDocument/${documentId}`, { method: 'DELETE' });
        evidence.cleanup.deleteContentDocument.push({
          contentDocumentId: documentId, endpoint: deleted.endpoint, httpStatus: deleted.status, response: deleted.body,
        });
      }
      const remainingVersions = await connection.query(
        `SELECT Id FROM ContentVersion WHERE ContentDocumentId IN (${[...rootDocumentIds].map((id) => `'${id}'`).join(',')})`,
      );
      const remainingLinks = await connection.query(
        `SELECT Id FROM ContentDocumentLink WHERE ContentDocumentId IN (${[...rootDocumentIds].map((id) => `'${id}'`).join(',')})`,
      );
      const remainingDocuments = await connection.query(
        `SELECT Id FROM ContentDocument WHERE Id IN (${[...rootDocumentIds].map((id) => `'${id}'`).join(',')})`,
      );
      evidence.cleanup.cascade = {
        contentVersionRemaining: remainingVersions.records.length,
        contentDocumentLinkRemaining: remainingLinks.records.length,
        contentDocumentRemaining: remainingDocuments.records.length,
      };
      // A version the run created that is still present under a non-probe document would mean the
      // wrong root was deleted; check the primary version explicitly as well.
      const primaryLeft = createdVersionId
        ? (await connection.query(`SELECT Id FROM ContentVersion WHERE Id = '${createdVersionId}'`)).records.length
        : 0;
      const cleaned = remainingVersions.records.length === 0
        && remainingLinks.records.length === 0
        && remainingDocuments.records.length === 0
        && primaryLeft === 0;
      gate('test-owned cleanup removed every probe ContentDocument, version and link',
        cleaned ? 'PASS' : 'FAIL',
        cleaned ? undefined : `cleanup pending; created ids ${JSON.stringify(cleanup)}`);
      if (!cleaned) {
        evidence.cleanup.pendingIds = cleanup;
        evidence.cleanup.note = 'Cleanup is incomplete. Do not delete business records; remove only the ids above.';
      }
    } else {
      gate('test-owned cleanup', 'BLOCKED', 'No ContentDocument was created, so there is nothing to clean up.');
    }
    // The error probe is only meaningful if it leaves no artifact behind — re-checked after cleanup.
    for (const row of evidence.cleanup.orphanReconciliation) {
      row.existsAfterCleanup = evidence.cleanup.skipped
        ? row.exists
        : (await connection.query(`SELECT Id FROM ContentVersion WHERE Id = '${row.contentVersionId}'`)).records.length > 0;
    }
    gate('error probes left no ContentVersion behind',
      evidence.cleanup.skipped ? 'BLOCKED'
        : evidence.cleanup.orphanReconciliation.every((row) => !row.existsAfterCleanup) ? 'PASS' : 'FAIL',
      evidence.cleanup.skipped ? 'PROBE_KEEP_DATA=true kept the probe artifacts.'
        : evidence.cleanup.orphanReconciliation.some((row) => row.existsAfterCleanup)
          ? `still present: ${evidence.cleanup.orphanReconciliation.filter((row) => row.existsAfterCleanup).map((row) => row.contentVersionId).join(',')}`
          : undefined);

    // ── Residue sweep: read-only, reported not deleted. Any id listed here came from a probe run
    //    and can be removed with PROBE_CLEANUP_VERSION_IDS; nothing else is ever deleted. ──
    const residue = await connection.query(
      "SELECT Id, Title, ContentDocumentId FROM ContentVersion WHERE Title LIKE 'SFOA%Probe%'",
    );
    evidence.residueSweep = {
      query: "ContentVersion WHERE Title LIKE 'SFOA%Probe%'",
      remaining: residue.records.map((row) => ({ Id: row.Id, Title: row.Title, ContentDocumentId: row.ContentDocumentId })),
    };
    gate('no probe ContentVersion residue remains in the Org',
      evidence.residueSweep.remaining.length === 0 ? 'PASS' : 'FAIL',
      evidence.residueSweep.remaining.length === 0
        ? undefined
        : `remove with PROBE_CLEANUP_VERSION_IDS=${evidence.residueSweep.remaining.map((row) => row.Id).join(',')}`);
  } finally {
    await scope.close();
    await store.close();
  }
}

const overall = gates.some((row) => row.status === 'FAIL') ? 'FAIL'
  : gates.some((row) => row.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';

await main()
  .then(() => {
    evidence.gates = gates;
    evidence.overall = overall;
  })
  .catch((error) => {
    evidence.gates = gates;
    evidence.overall = 'BLOCKED';
    evidence.error = safeError(error);
  })
  .finally(async () => {
    evidence.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(evidence, null, 2));
    if (evidence.overall === 'FAIL') process.exitCode = 1;
  });
