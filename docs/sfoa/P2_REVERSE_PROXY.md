# P2 Reverse Proxy Contract

P2 does not deploy Nginx. This document defines the boundary a future TLS/reverse proxy must preserve when routing `/mcp` to `@sfoa/mcp-server`.

## Route

```text
https://mcp.example.internal/mcp
        -> reverse proxy
        -> http://127.0.0.1:8080/mcp
```

The Node runtime remains stateless. The proxy must not create Salesforce credentials, rewrite Tool arguments, or turn an untrusted query/body value into `platformUserId`.

## Header contract

| Header | Proxy behavior | Node trust |
| --- | --- | --- |
| `Host` | Preserve the externally accepted host or set one fixed deployment host | Exact-match against `MCP_ALLOWED_HOSTS`; reject before JWT |
| `Authorization` | Preserve end-to-end; never log it | Validated as `Bearer <MCP_CLIENT_TOKEN>` before accepting platform identity |
| `X-Platform-User-Id` (or configured name) | Preserve only from the controlled authenticated MCP client/gateway | Authoritative routing input only after Bearer authentication; never accepted from body/query/Tool args |
| `X-Correlation-Id` | Preserve a valid client value or let Node generate one | Observability only; never authorization |
| `X-Forwarded-For` | Remove any inbound value and set/append from the proxy's observed peer address | P2 does not use it for authorization |
| `X-Forwarded-Proto` | Remove inbound value and set from the proxy's TLS state (`https`) | P2 does not use it for authorization |
| `Origin` | Preserve if the client sends it | Exact-match against `MCP_ALLOWED_ORIGINS`; omission is valid for non-browser MCP clients |
| Salesforce username/token/password/private key headers | Strip | Never part of the client contract |

`X-Forwarded-For` and `X-Forwarded-Proto` become trustworthy only because a known proxy overwrites them and direct access to the Node port is blocked. P2 does not currently consume them, so they cannot grant access.

## Deployment requirements

1. Bind Node to `127.0.0.1` when Nginx is on the same host. Use `0.0.0.0` only for a deliberate private-network topology.
2. Set `MCP_ALLOWED_HOSTS=mcp.example.internal` (include the port when the incoming `Host` includes one).
3. Set exact browser origins only when a browser MCP client is expected. Do not use `*`.
4. Terminate TLS at the proxy and restrict direct access to the Node port.
5. Store the client token in the proxy/client secret store or ignored `.env.local`; do not embed it in Nginx access logs.
6. Apply proxy body and time limits no looser than Node's `MCP_MAX_BODY_BYTES` and `MCP_REQUEST_TIMEOUT_MS`. Node remains the final bound.
7. Disable request/response-body logging for `/mcp`; Tool results can contain Salesforce records.

## Illustrative Nginx shape

This is a contract example, not a deployment artifact:

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:8080/mcp;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Platform-User-Id $http_x_platform_user_id;
    proxy_set_header X-Correlation-Id $http_x_correlation_id;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    client_max_body_size 1m;
    proxy_read_timeout 60s;
}
```

The shown platform Header forwarding is safe only for the controlled internal MCP-client model used by P2. If a future public/untrusted client can choose this header, a trusted gateway must derive it from authenticated session claims and overwrite the inbound value before P2 receives it.
