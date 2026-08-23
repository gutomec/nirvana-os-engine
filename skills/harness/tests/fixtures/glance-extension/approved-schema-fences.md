### glance-extension-manifest.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.nirvana-os.dev/glance/extension-manifest/1.0.0",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "id", "version", "display", "compatibility", "ui", "datasets", "files", "capabilities", "provenance", "external_navigation"],
  "properties": {
    "schema_version": { "const": "1.0.0" },
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{2,62}$" },
    "version": { "$ref": "#/$defs/semver" },
    "display": {
      "type": "object",
      "additionalProperties": false,
      "required": ["title", "description", "icon", "order"],
      "properties": {
        "title": { "type": "string", "minLength": 1, "maxLength": 60 },
        "description": { "type": "string", "minLength": 1, "maxLength": 180 },
        "icon": { "enum": ["activity", "database", "git-pull-request", "package-check", "shield-check"] },
        "order": { "type": "integer", "minimum": 100, "maximum": 999 }
      }
    },
    "compatibility": {
      "type": "object",
      "additionalProperties": false,
      "required": ["minimum", "maximum_tested"],
      "properties": {
        "minimum": { "$ref": "#/$defs/semver" },
        "maximum_tested": { "$ref": "#/$defs/semver" }
      }
    },
    "ui": {
      "type": "object",
      "additionalProperties": false,
      "required": ["entrypoint", "sandbox", "theme_contract"],
      "properties": {
        "entrypoint": { "const": "ui/index.html" },
        "sandbox": { "const": "allow-scripts" },
        "theme_contract": { "const": "glance.ui.tokens.v1" }
      }
    },
    "datasets": {
      "type": "array",
      "minItems": 1,
      "maxItems": 16,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "path", "envelope_schema", "payload_schema", "max_bytes", "refresh"],
        "properties": {
          "id": { "$ref": "#/$defs/id" },
          "path": { "type": "string", "pattern": "^data/[a-z0-9][a-z0-9-]{2,62}\\.snapshot\\.json$", "maxLength": 96 },
          "envelope_schema": { "const": "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0" },
          "payload_schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "version", "digest"],
            "properties": {
              "id": { "type": "string", "minLength": 3, "maxLength": 200 },
              "version": { "$ref": "#/$defs/semver" },
              "digest": { "$ref": "#/$defs/digest" }
            }
          },
          "max_bytes": { "type": "integer", "minimum": 1024, "maximum": 5242880 },
          "refresh": { "const": "on-request" }
        }
      }
    },
    "files": {
      "type": "array",
      "minItems": 1,
      "maxItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path", "mime", "bytes", "sha256"],
        "properties": {
          "path": { "const": "ui/index.html" },
          "mime": { "const": "text/html; charset=utf-8" },
          "bytes": { "type": "integer", "minimum": 1, "maximum": 2097152 },
          "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
        }
      }
    },
    "capabilities": { "const": ["read_snapshot"] },
    "provenance": {
      "type": "object",
      "additionalProperties": false,
      "required": ["publisher_id", "build_id", "built_at", "source_ref"],
      "properties": {
        "publisher_id": { "$ref": "#/$defs/id" },
        "build_id": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" },
        "built_at": { "type": "string", "format": "date-time" },
        "source_ref": { "type": "string", "minLength": 1, "maxLength": 300 }
      }
    },
    "external_navigation": {
      "type": "object",
      "additionalProperties": false,
      "required": ["mode", "allowed_hosts"],
      "properties": {
        "mode": { "const": "host-mediated" },
        "allowed_hosts": {
          "type": "array",
          "maxItems": 1,
          "uniqueItems": true,
          "items": { "enum": ["github.com"] }
        }
      }
    }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{2,62}$" },
    "semver": { "type": "string", "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$" },
    "digest": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" }
  }
}
```

### glance-extension-dataset-envelope.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "extension_id", "dataset_id", "snapshot_id", "generated_at", "status", "scope", "subject", "source", "freshness", "payload_schema", "evidence_refs", "integrity", "payload"],
  "properties": {
    "schema_version": { "const": "1.0.0" },
    "extension_id": { "$ref": "#/$defs/id" },
    "dataset_id": { "$ref": "#/$defs/id" },
    "snapshot_id": { "$ref": "#/$defs/digest" },
    "generated_at": { "type": "string", "format": "date-time" },
    "status": { "enum": ["pass", "partial", "indeterminate", "fail"] },
    "scope": { "oneOf": [{ "$ref": "#/$defs/globalScope" }, { "$ref": "#/$defs/projectScope" }] },
    "subject": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "id", "digest"],
      "properties": {
        "type": { "$ref": "#/$defs/id" },
        "id": { "type": "string", "minLength": 1, "maxLength": 200 },
        "digest": { "$ref": "#/$defs/digest" }
      }
    },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "label", "digest", "artifacts"],
      "properties": {
        "kind": { "enum": ["local_file", "local_command", "remote_api", "composite"] },
        "label": { "type": "string", "minLength": 1, "maxLength": 120 },
        "digest": { "$ref": "#/$defs/digest" },
        "artifacts": {
          "type": "array",
          "minItems": 1,
          "maxItems": 128,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "digest"],
            "properties": {
              "id": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" },
              "digest": { "$ref": "#/$defs/digest" }
            }
          }
        }
      }
    },
    "freshness": {
      "type": "object",
      "additionalProperties": false,
      "required": ["observed_at", "max_age_seconds", "state"],
      "properties": {
        "observed_at": { "type": "string", "format": "date-time" },
        "max_age_seconds": { "type": "integer", "minimum": 1, "maximum": 31536000 },
        "state": { "enum": ["fresh", "stale", "expired", "unknown"] }
      }
    },
    "payload_schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "version", "digest"],
      "properties": {
        "id": { "type": "string", "minLength": 3, "maxLength": 200 },
        "version": { "$ref": "#/$defs/semver" },
        "digest": { "$ref": "#/$defs/digest" }
      }
    },
    "evidence_refs": {
      "type": "array",
      "maxItems": 128,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "kind", "ref"],
        "properties": {
          "id": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" },
          "kind": { "enum": ["file", "url", "audit_event", "digest"] },
          "ref": { "type": "string", "minLength": 1, "maxLength": 500 },
          "digest": { "$ref": "#/$defs/digest" }
        }
      }
    },
    "integrity": {
      "type": "object",
      "additionalProperties": false,
      "required": ["algorithm", "payload_digest"],
      "properties": {
        "algorithm": { "const": "sha256" },
        "payload_digest": { "$ref": "#/$defs/digest" }
      }
    },
    "payload": true
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{2,62}$" },
    "semver": { "type": "string", "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$" },
    "digest": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
    "globalScope": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind"],
      "properties": { "kind": { "const": "global" } }
    },
    "projectScope": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "project_root_digest"],
      "properties": {
        "kind": { "const": "project" },
        "project_root_digest": { "$ref": "#/$defs/digest" }
      }
    }
  }
}
```

### glance-extension-catalog.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.nirvana-os.dev/glance/extension-catalog/1.0.0",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "extension_api_version", "scope", "extensions", "diagnostics"],
  "properties": {
    "schema_version": { "const": "1.0.0" },
    "extension_api_version": { "const": "1.0.0" },
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "root_digest"],
      "properties": {
        "kind": { "enum": ["global", "project"] },
        "root_digest": { "$ref": "#/$defs/digest" }
      }
    },
    "extensions": {
      "type": "array",
      "maxItems": 64,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "version", "title", "description", "icon", "order", "status", "trust", "manifest_digest", "datasets"],
        "properties": {
          "id": { "$ref": "#/$defs/id" },
          "version": { "$ref": "#/$defs/semver" },
          "title": { "type": "string", "minLength": 1, "maxLength": 60 },
          "description": { "type": "string", "minLength": 1, "maxLength": 180 },
          "icon": { "enum": ["activity", "database", "git-pull-request", "package-check", "shield-check"] },
          "order": { "type": "integer", "minimum": 100, "maximum": 999 },
          "status": { "enum": ["accepted", "incompatible", "rejected"] },
          "trust": {
            "type": "object",
            "additionalProperties": false,
            "required": ["level", "basis"],
            "properties": {
              "level": { "const": "local_owner" },
              "basis": { "const": ["filesystem_owner"] }
            }
          },
          "manifest_digest": { "$ref": "#/$defs/digest" },
          "datasets": {
            "type": "array",
            "minItems": 1,
            "maxItems": 16,
            "uniqueItems": true,
            "items": { "$ref": "#/$defs/id" }
          }
        }
      }
    },
    "diagnostics": {
      "type": "array",
      "maxItems": 256,
      "items": { "$ref": "https://schemas.nirvana-os.dev/glance/public-error/1.0.0" }
    }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{2,62}$" },
    "semver": { "type": "string", "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$" },
    "digest": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" }
  }
}
```

### glance-extension-public-error.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.nirvana-os.dev/glance/public-error/1.0.0",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "error"],
  "properties": {
    "schema_version": { "const": "1.0.0" },
    "error": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message", "retryable", "correlation_id"],
      "properties": {
        "code": { "enum": ["COLLISION", "DATASET_INVALID", "EXTENSION_INCOMPATIBLE", "EXTENSION_NOT_FOUND", "FILE_INTEGRITY", "MANIFEST_INVALID", "METHOD_NOT_ALLOWED", "PATH_UNSAFE", "SCOPE_MISMATCH", "UI_HANDSHAKE", "URL_REJECTED"] },
        "message": { "type": "string", "minLength": 1, "maxLength": 200 },
        "retryable": { "type": "boolean" },
        "correlation_id": { "type": "string", "format": "uuid" },
        "extension_id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{2,62}$" },
        "dataset_id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{2,62}$" }
      }
    }
  }
}
```

### glance-extension-message.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.nirvana-os.dev/glance/message/1.0.0",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "protocol", "session_id", "sequence", "type", "payload"],
  "properties": {
    "schema_version": { "const": "1.0.0" },
    "protocol": { "const": "glance.extension.messages" },
    "session_id": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "sequence": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "type": { "enum": ["extension.ready", "host.init", "host.dataset", "host.refreshing", "host.error", "extension.rendered", "extension.error", "extension.open_external_url"] },
    "payload": {}
  },
  "allOf": [
    { "if": { "properties": { "type": { "const": "extension.ready" } } }, "then": { "properties": { "payload": { "$ref": "#/$defs/ready" } } } },
    { "if": { "properties": { "type": { "const": "host.init" } } }, "then": { "properties": { "payload": { "$ref": "#/$defs/init" } } } },
    { "if": { "properties": { "type": { "const": "host.dataset" } } }, "then": { "properties": { "payload": { "$ref": "#/$defs/dataset" } } } },
    { "if": { "properties": { "type": { "const": "host.refreshing" } } }, "then": { "properties": { "payload": { "$ref": "#/$defs/refreshing" } } } },
    { "if": { "properties": { "type": { "const": "host.error" } } }, "then": { "properties": { "payload": { "$ref": "#/$defs/hostError" } } } },
    { "if": { "properties": { "type": { "const": "extension.rendered" } } }, "then": { "properties": { "payload": { "$ref": "#/$defs/rendered" } } } },
    { "if": { "properties": { "type": { "const": "extension.error" } } }, "then": { "properties": { "payload": { "$ref": "#/$defs/extensionError" } } } },
    { "if": { "properties": { "type": { "const": "extension.open_external_url" } } }, "then": { "properties": { "payload": { "$ref": "#/$defs/openExternal" } } } }
  ],
  "$defs": {
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{2,62}$" },
    "digest": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
    "ready": {
      "type": "object", "additionalProperties": false,
      "required": ["ui_version", "accepted_envelope_versions"],
      "properties": {
        "ui_version": { "type": "string", "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" },
        "accepted_envelope_versions": { "const": ["1.0.0"] }
      }
    },
    "init": {
      "type": "object", "additionalProperties": false,
      "required": ["extension_id", "api_version", "locale", "theme", "tokens"],
      "properties": {
        "extension_id": { "$ref": "#/$defs/id" },
        "api_version": { "const": "1.0.0" },
        "locale": { "type": "string", "pattern": "^[a-z]{2}(?:-[A-Z]{2})?$" },
        "theme": { "enum": ["apple", "apple-dark", "awwwards"] },
        "tokens": {
          "type": "object", "additionalProperties": false,
          "required": ["surface-0", "surface-1", "surface-2", "text-primary", "text-secondary", "border-default", "border-focus", "accent", "success-fg", "warn-fg", "danger-fg", "space-2"],
          "properties": {
            "surface-0": { "type": "string", "maxLength": 64 }, "surface-1": { "type": "string", "maxLength": 64 }, "surface-2": { "type": "string", "maxLength": 64 },
            "text-primary": { "type": "string", "maxLength": 64 }, "text-secondary": { "type": "string", "maxLength": 64 },
            "border-default": { "type": "string", "maxLength": 64 }, "border-focus": { "type": "string", "maxLength": 64 }, "accent": { "type": "string", "maxLength": 64 },
            "success-fg": { "type": "string", "maxLength": 64 }, "warn-fg": { "type": "string", "maxLength": 64 }, "danger-fg": { "type": "string", "maxLength": 64 }, "space-2": { "type": "string", "maxLength": 32 }
          }
        }
      }
    },
    "dataset": {
      "type": "object", "additionalProperties": false,
      "required": ["dataset_id", "envelope"],
      "properties": {
        "dataset_id": { "$ref": "#/$defs/id" },
        "envelope": { "$ref": "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0" }
      }
    },
    "refreshing": {
      "type": "object", "additionalProperties": false,
      "required": ["dataset_id"],
      "properties": { "dataset_id": { "$ref": "#/$defs/id" } }
    },
    "hostError": {
      "$ref": "https://schemas.nirvana-os.dev/glance/public-error/1.0.0"
    },
    "rendered": {
      "type": "object", "additionalProperties": false,
      "required": ["snapshot_id"],
      "properties": { "snapshot_id": { "$ref": "#/$defs/digest" } }
    },
    "extensionError": {
      "type": "object", "additionalProperties": false,
      "required": ["code", "message"],
      "properties": {
        "code": { "enum": ["PAYLOAD_SCHEMA_INVALID", "RENDER_FAILED"] },
        "message": { "type": "string", "minLength": 1, "maxLength": 200 }
      }
    },
    "openExternal": {
      "type": "object", "additionalProperties": false,
      "required": ["request_id", "url", "display_label"],
      "properties": {
        "request_id": { "type": "string", "format": "uuid" },
        "url": { "type": "string", "format": "uri", "maxLength": 2048 },
        "display_label": { "type": "string", "minLength": 1, "maxLength": 120 }
      }
    }
  }
}
```

