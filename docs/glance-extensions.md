# Glance extensions

Glance Extension Protocol 1.0 loads static, read-only dashboards from a local,
user-owned directory. An extension contributes one inventoried HTML document
and one or more validated snapshot datasets. It does not add server code,
execute a publisher, install dependencies, or receive a general Glance API.

## Roots and scope selection

Glance selects exactly one extension root at startup:

| Scope | Root |
|---|---|
| `global` | `${NIRVANA_HOME}/.nirvana/glance/extensions/` |
| `project` | `<project-root>/.nirvana/glance/extensions/` |

When `NIRVANA_HOME` is unset, the user's home directory is used. Project scope
requires a project root found from the working directory or pinned with
`NIRVANA_PROJECT_ROOT`. Start Glance with `nrv glance --scope=global` or from
the intended project with `nrv glance --scope=project`. Protocol 1.0 does not
merge, overlay, or fall back between roots. `merge` remains available to the
legacy Glance catalog, but extension discovery is disabled in that mode.

The same extension ID may exist in the global and project roots because only
one root is active. Within the selected root, IDs are compared as lowercase
ASCII. A collision rejects every participant. Core IDs such as `agents`,
`runs`, `squads`, `businesses`, `projects`, `mind-clones`, `memory`, `graph`,
and `cost` are reserved.

## Install by copy

There is no installation endpoint. Install an extension by copying its whole
directory under the selected root:

```text
extensions/
└── <extension-id>/
    ├── glance-extension.json
    ├── ui/
    │   └── index.html
    └── data/
        └── <dataset-id>.snapshot.json
```

Treat the directory as one release. Build it beside the live root, validate
the manifest and every declared byte, retain the previous directory as a
backup, then replace the directory as one local operation. Do not copy into
the engine checkout or into a pack-owned directory. Symlinks, junctions,
reparse points, absolute paths, traversal, control characters, and Windows
Alternate Data Streams are rejected.

Restart Glance after adding, removing, or changing a manifest. Discovery and
compatibility selection happen at process bootstrap. Dataset files are read
on request, so an atomic snapshot replacement can be observed by closing and
reopening the extension without running its publisher through Glance.

## Validation and acceptance

The loader parses strict UTF-8 JSON with closed Draft 2020-12 schemas, then
applies semantic, scope, compatibility, path, inventory, and digest checks.
It accepts only exact protocol and SemVer values. Manifested UI bytes and
dataset envelopes are reopened from the selected root and checked before
delivery. The payload remains opaque to the core; its domain schema must be
validated by the extension UI before a positive display state.

An accepted manifest appears in `GET /api/extensions` with status `accepted`.
Incompatible and rejected manifests remain visible as safe catalog metadata
when their identity can be established. Physical paths, stacks, payloads,
secrets, and evidence contents are never public diagnostics. The normal
Glance dashboard continues to work when no extension is accepted.

## Public errors and diagnostics

`GET /api/extensions` returns the catalog and its redacted `diagnostics`
array. Each public diagnostic carries a `correlation_id` without exposing a
physical path or internal failure detail. The closed public error codes are:

| Code | Meaning |
|---|---|
| `COLLISION` | More than one directory declares the same active-scope ID. |
| `DATASET_INVALID` | The envelope, semantics, or digest is invalid. |
| `EXTENSION_INCOMPATIBLE` | Host API version is outside the declared tested range. |
| `EXTENSION_NOT_FOUND` | The ID, dataset, or UI route is not accepted or present. |
| `FILE_INTEGRITY` | Inventoried bytes changed or do not match. |
| `MANIFEST_INVALID` | Schema or manifest semantics failed. |
| `METHOD_NOT_ALLOWED` | The extension route received a method other than GET or HEAD. |
| `PATH_UNSAFE` | A root, directory, or file path failed containment checks. |
| `SCOPE_MISMATCH` | Dataset scope does not match the selected root. |
| `UI_HANDSHAKE` | The isolated UI did not establish the protocol in time. |
| `URL_REJECTED` | External navigation failed the host policy. |

For a missing extension, confirm the active scope first, then inspect the
catalog status and diagnostics. For `FILE_INTEGRITY`, compare the manifest's
byte count and SHA-256 with the current file. For `SCOPE_MISMATCH`, regenerate
the snapshot for the active global or project root. Glance never repairs or
migrates an extension automatically.

## Limits

Protocol 1.0 enforces these ceilings:

| Resource | Limit |
|---|---:|
| Extensions in one selected root | 64 |
| Datasets per extension | 16 |
| Manifest | 128 KiB |
| Inventoried UI | 2 MiB |
| One dataset | 5 MiB |
| Total inventoried bytes per extension | 16 MiB |
| Evidence references per dataset | 128 |

The host is local and read-only. It adds no cloud service, database, container,
GPU, public port, or polling source. A malicious static UI can still consume
CPU in its own tab; the sandbox, handshake timeout, bounded files, and ability
to close the extension limit that exposure.

## Trust and isolation

Catalog trust is `local_owner` with basis `filesystem_owner`. This means the
current user controls the installation directory. It is not publisher
authentication. Provenance fields and SHA-256 digests detect drift and bind
bytes; they do not prove who authored the extension or that its intent is
safe.

The UI runs in `iframe sandbox="allow-scripts"` without same-origin, forms,
popups, downloads, top navigation, host DOM, cookies, local storage, internal
APIs, or filesystem access. The host transfers one source-bound
`MessagePort`. All later messages have a session ID, monotonic sequence, fixed
direction, closed schema, and bounded content. External navigation is
host-mediated and currently limited to exact HTTPS `github.com` after a
trusted host-side pointer or keyboard confirmation.

## HTTP routes and headers

The extension surface accepts GET and HEAD only:

```text
/api/extensions
/api/extensions/:id
/api/extensions/:id/datasets/:datasetId
/extensions/:id/ui/index.html
```

JSON responses use `Content-Type: application/json; charset=utf-8`,
`Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. The UI also
uses `Referrer-Policy: no-referrer` and this Content Security Policy:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'
```

The inline script and style allowance applies only to the single inventoried
document. Network access remains denied.

## Bootstrap, port, and refresh

`nrv glance` binds the existing Glance process to loopback, chooses an
available port, and opens the browser. Use `nrv glance --port 4242` for a
fixed local port or `--no-open` to open the printed URL yourself. Extension
discovery runs once during this bootstrap. A discovery failure disables only
the extension routes, reports a local diagnostic, and leaves legacy Glance
available.

Opening an accepted extension requests its current dataset. The manifest's
`refresh: on-request` means reopening the extension rereads the already
published snapshot; it never executes a local command, calls a remote API, or
starts the publisher. Replace snapshots atomically so a reader sees either the
previous complete file or the new complete file.

## Preservation and rollback

Global and project extension roots belong to the user. Engine updates,
uninstall, pack updates, and rollback must preserve them by default. An engine
update may change the host API version; an extension outside its declared
range becomes `incompatible` and is not migrated silently.

To roll back an extension, stop Glance, restore the previous complete
extension directory, and restart with the same scope. To roll back the engine
change, remove the Extension API host, routes, and loader while retaining both
user roots. An older Glance ignores those directories, and a later compatible
installation can discover them again. Manual deletion by the same user or an
external tool is outside this preservation guarantee.

## Erratum: traffic after MessageChannel close

The approved Glance Extension API specification, section 41.5, says a message
after channel close is rejected and audited. The real platform behavior is
more specific: a closed `MessagePort` discards later sends without delivery.
The observable acceptance evidence is exactly one redacted
`extension_channel_closed` audit, one real close event on each port, and zero
later delivery, state transition, or message audit.

The behavioral test
[`EXT-HOST-AFTER-CLOSE-IS-DISCARDED`](../skills/harness/tests/glance-extension-host-state.test.ts)
binds this erratum. The host does not add a parallel closed-state machine and
the harness does not intercept `postMessage` to manufacture evidence.

## Verification boundary

The mandatory browser contract uses an existing local Chrome, Chromium, or
Edge executable and obtains acceptance fields from the in-session CDP
`Browser.getVersion` response. Diagnostic `--version` stdout is not acceptance
evidence. The local Windows run observed `Chrome/151.0.7922.174`, CDP protocol
`1.3`, non-empty revision, user-agent and JavaScript version fields, and
synchronous process, connection, and temporary-profile cleanup. Linux and
macOS evidence can exist only after the branch is published and the three-OS
GitHub Actions matrix runs; it is not claimed by this local change.
