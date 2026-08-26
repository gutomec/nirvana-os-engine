// Generated document block: run `bun scripts/generate-glance-browser-schemas.ts`.
// BEGIN GENERATED GLANCE SCHEMA DOCUMENTS
export const BROWSER_SCHEMA_DOCUMENTS = [
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.nirvana-os.dev/glance/extension-manifest/1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "id",
      "version",
      "display",
      "compatibility",
      "ui",
      "datasets",
      "files",
      "capabilities",
      "provenance",
      "external_navigation"
    ],
    "properties": {
      "schema_version": {
        "const": "1.0.0"
      },
      "id": {
        "type": "string",
        "pattern": "^[a-z0-9][a-z0-9-]{2,62}$"
      },
      "version": {
        "$ref": "#/$defs/semver"
      },
      "display": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "title",
          "description",
          "icon",
          "order"
        ],
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 60
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 180
          },
          "icon": {
            "enum": [
              "activity",
              "database",
              "git-pull-request",
              "package-check",
              "shield-check"
            ]
          },
          "order": {
            "type": "integer",
            "minimum": 100,
            "maximum": 999
          }
        }
      },
      "compatibility": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "minimum",
          "maximum_tested"
        ],
        "properties": {
          "minimum": {
            "$ref": "#/$defs/semver"
          },
          "maximum_tested": {
            "$ref": "#/$defs/semver"
          }
        }
      },
      "ui": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "entrypoint",
          "sandbox",
          "theme_contract"
        ],
        "properties": {
          "entrypoint": {
            "const": "ui/index.html"
          },
          "sandbox": {
            "const": "allow-scripts"
          },
          "theme_contract": {
            "const": "glance.ui.tokens.v1"
          }
        }
      },
      "datasets": {
        "type": "array",
        "minItems": 1,
        "maxItems": 16,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "path",
            "envelope_schema",
            "payload_schema",
            "max_bytes",
            "refresh"
          ],
          "properties": {
            "id": {
              "$ref": "#/$defs/id"
            },
            "path": {
              "type": "string",
              "pattern": "^data/[a-z0-9][a-z0-9-]{2,62}\\.snapshot\\.json$",
              "maxLength": 96
            },
            "envelope_schema": {
              "const": "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0"
            },
            "payload_schema": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "id",
                "version",
                "digest"
              ],
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 3,
                  "maxLength": 200
                },
                "version": {
                  "$ref": "#/$defs/semver"
                },
                "digest": {
                  "$ref": "#/$defs/digest"
                }
              }
            },
            "max_bytes": {
              "type": "integer",
              "minimum": 1024,
              "maximum": 5242880
            },
            "refresh": {
              "const": "on-request"
            }
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
          "required": [
            "path",
            "mime",
            "bytes",
            "sha256"
          ],
          "properties": {
            "path": {
              "const": "ui/index.html"
            },
            "mime": {
              "const": "text/html; charset=utf-8"
            },
            "bytes": {
              "type": "integer",
              "minimum": 1,
              "maximum": 2097152
            },
            "sha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          }
        }
      },
      "capabilities": {
        "const": [
          "read_snapshot"
        ]
      },
      "provenance": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "publisher_id",
          "build_id",
          "built_at",
          "source_ref"
        ],
        "properties": {
          "publisher_id": {
            "$ref": "#/$defs/id"
          },
          "build_id": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:-]{1,128}$"
          },
          "built_at": {
            "type": "string",
            "format": "date-time"
          },
          "source_ref": {
            "type": "string",
            "minLength": 1,
            "maxLength": 300
          }
        }
      },
      "external_navigation": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "mode",
          "allowed_hosts"
        ],
        "properties": {
          "mode": {
            "const": "host-mediated"
          },
          "allowed_hosts": {
            "type": "array",
            "maxItems": 1,
            "uniqueItems": true,
            "items": {
              "enum": [
                "github.com"
              ]
            }
          }
        }
      }
    },
    "$defs": {
      "id": {
        "type": "string",
        "pattern": "^[a-z0-9][a-z0-9-]{2,62}$"
      },
      "semver": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
      },
      "digest": {
        "type": "string",
        "pattern": "^sha256:[a-f0-9]{64}$"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "extension_id",
      "dataset_id",
      "snapshot_id",
      "generated_at",
      "status",
      "scope",
      "subject",
      "source",
      "freshness",
      "payload_schema",
      "evidence_refs",
      "integrity",
      "payload"
    ],
    "properties": {
      "schema_version": {
        "const": "1.0.0"
      },
      "extension_id": {
        "$ref": "#/$defs/id"
      },
      "dataset_id": {
        "$ref": "#/$defs/id"
      },
      "snapshot_id": {
        "$ref": "#/$defs/digest"
      },
      "generated_at": {
        "type": "string",
        "format": "date-time"
      },
      "status": {
        "enum": [
          "pass",
          "partial",
          "indeterminate",
          "fail"
        ]
      },
      "scope": {
        "oneOf": [
          {
            "$ref": "#/$defs/globalScope"
          },
          {
            "$ref": "#/$defs/projectScope"
          }
        ]
      },
      "subject": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "type",
          "id",
          "digest"
        ],
        "properties": {
          "type": {
            "$ref": "#/$defs/id"
          },
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "digest": {
            "$ref": "#/$defs/digest"
          }
        }
      },
      "source": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "label",
          "digest",
          "artifacts"
        ],
        "properties": {
          "kind": {
            "enum": [
              "local_file",
              "local_command",
              "remote_api",
              "composite"
            ]
          },
          "label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "digest": {
            "$ref": "#/$defs/digest"
          },
          "artifacts": {
            "type": "array",
            "minItems": 1,
            "maxItems": 128,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "id",
                "digest"
              ],
              "properties": {
                "id": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9._:-]{1,128}$"
                },
                "digest": {
                  "$ref": "#/$defs/digest"
                }
              }
            }
          }
        }
      },
      "freshness": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "max_age_seconds",
          "state"
        ],
        "properties": {
          "observed_at": {
            "type": "string",
            "format": "date-time"
          },
          "max_age_seconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 31536000
          },
          "state": {
            "enum": [
              "fresh",
              "stale",
              "expired",
              "unknown"
            ]
          }
        }
      },
      "payload_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 3,
            "maxLength": 200
          },
          "version": {
            "$ref": "#/$defs/semver"
          },
          "digest": {
            "$ref": "#/$defs/digest"
          }
        }
      },
      "evidence_refs": {
        "type": "array",
        "maxItems": 128,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "kind",
            "ref"
          ],
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:-]{1,128}$"
            },
            "kind": {
              "enum": [
                "file",
                "url",
                "audit_event",
                "digest"
              ]
            },
            "ref": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            },
            "digest": {
              "$ref": "#/$defs/digest"
            }
          }
        }
      },
      "integrity": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "algorithm",
          "payload_digest"
        ],
        "properties": {
          "algorithm": {
            "const": "sha256"
          },
          "payload_digest": {
            "$ref": "#/$defs/digest"
          }
        }
      },
      "payload": true
    },
    "$defs": {
      "id": {
        "type": "string",
        "pattern": "^[a-z0-9][a-z0-9-]{2,62}$"
      },
      "semver": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
      },
      "digest": {
        "type": "string",
        "pattern": "^sha256:[a-f0-9]{64}$"
      },
      "globalScope": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind"
        ],
        "properties": {
          "kind": {
            "const": "global"
          }
        }
      },
      "projectScope": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "project_root_digest"
        ],
        "properties": {
          "kind": {
            "const": "project"
          },
          "project_root_digest": {
            "$ref": "#/$defs/digest"
          }
        }
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.nirvana-os.dev/glance/extension-catalog/1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "extension_api_version",
      "scope",
      "extensions",
      "diagnostics"
    ],
    "properties": {
      "schema_version": {
        "const": "1.0.0"
      },
      "extension_api_version": {
        "const": "1.0.0"
      },
      "scope": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "root_digest"
        ],
        "properties": {
          "kind": {
            "enum": [
              "global",
              "project"
            ]
          },
          "root_digest": {
            "$ref": "#/$defs/digest"
          }
        }
      },
      "extensions": {
        "type": "array",
        "maxItems": 64,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "version",
            "title",
            "description",
            "icon",
            "order",
            "status",
            "trust",
            "manifest_digest",
            "datasets"
          ],
          "properties": {
            "id": {
              "$ref": "#/$defs/id"
            },
            "version": {
              "$ref": "#/$defs/semver"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 60
            },
            "description": {
              "type": "string",
              "minLength": 1,
              "maxLength": 180
            },
            "icon": {
              "enum": [
                "activity",
                "database",
                "git-pull-request",
                "package-check",
                "shield-check"
              ]
            },
            "order": {
              "type": "integer",
              "minimum": 100,
              "maximum": 999
            },
            "status": {
              "enum": [
                "accepted",
                "incompatible",
                "rejected"
              ]
            },
            "trust": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "level",
                "basis"
              ],
              "properties": {
                "level": {
                  "const": "local_owner"
                },
                "basis": {
                  "const": [
                    "filesystem_owner"
                  ]
                }
              }
            },
            "manifest_digest": {
              "$ref": "#/$defs/digest"
            },
            "datasets": {
              "type": "array",
              "minItems": 1,
              "maxItems": 16,
              "uniqueItems": true,
              "items": {
                "$ref": "#/$defs/id"
              }
            }
          }
        }
      },
      "diagnostics": {
        "type": "array",
        "maxItems": 256,
        "items": {
          "$ref": "https://schemas.nirvana-os.dev/glance/public-error/1.0.0"
        }
      }
    },
    "$defs": {
      "id": {
        "type": "string",
        "pattern": "^[a-z0-9][a-z0-9-]{2,62}$"
      },
      "semver": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
      },
      "digest": {
        "type": "string",
        "pattern": "^sha256:[a-f0-9]{64}$"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.nirvana-os.dev/glance/public-error/1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "error"
    ],
    "properties": {
      "schema_version": {
        "const": "1.0.0"
      },
      "error": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "code",
          "message",
          "retryable",
          "correlation_id"
        ],
        "properties": {
          "code": {
            "enum": [
              "COLLISION",
              "DATASET_INVALID",
              "EXTENSION_INCOMPATIBLE",
              "EXTENSION_NOT_FOUND",
              "FILE_INTEGRITY",
              "MANIFEST_INVALID",
              "METHOD_NOT_ALLOWED",
              "PATH_UNSAFE",
              "SCOPE_MISMATCH",
              "UI_HANDSHAKE",
              "URL_REJECTED"
            ]
          },
          "message": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "retryable": {
            "type": "boolean"
          },
          "correlation_id": {
            "type": "string",
            "format": "uuid"
          },
          "extension_id": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9-]{2,62}$"
          },
          "dataset_id": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9-]{2,62}$"
          }
        }
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.nirvana-os.dev/glance/message/1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "protocol",
      "session_id",
      "sequence",
      "type",
      "payload"
    ],
    "properties": {
      "schema_version": {
        "const": "1.0.0"
      },
      "protocol": {
        "const": "glance.extension.messages"
      },
      "session_id": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "sequence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "type": {
        "enum": [
          "extension.ready",
          "host.init",
          "host.dataset",
          "host.refreshing",
          "host.error",
          "extension.rendered",
          "extension.error",
          "extension.open_external_url"
        ]
      },
      "payload": {}
    },
    "allOf": [
      {
        "if": {
          "properties": {
            "type": {
              "const": "extension.ready"
            }
          }
        },
        "then": {
          "properties": {
            "payload": {
              "$ref": "#/$defs/ready"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "host.init"
            }
          }
        },
        "then": {
          "properties": {
            "payload": {
              "$ref": "#/$defs/init"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "host.dataset"
            }
          }
        },
        "then": {
          "properties": {
            "payload": {
              "$ref": "#/$defs/dataset"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "host.refreshing"
            }
          }
        },
        "then": {
          "properties": {
            "payload": {
              "$ref": "#/$defs/refreshing"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "host.error"
            }
          }
        },
        "then": {
          "properties": {
            "payload": {
              "$ref": "#/$defs/hostError"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "extension.rendered"
            }
          }
        },
        "then": {
          "properties": {
            "payload": {
              "$ref": "#/$defs/rendered"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "extension.error"
            }
          }
        },
        "then": {
          "properties": {
            "payload": {
              "$ref": "#/$defs/extensionError"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "extension.open_external_url"
            }
          }
        },
        "then": {
          "properties": {
            "payload": {
              "$ref": "#/$defs/openExternal"
            }
          }
        }
      }
    ],
    "$defs": {
      "id": {
        "type": "string",
        "pattern": "^[a-z0-9][a-z0-9-]{2,62}$"
      },
      "digest": {
        "type": "string",
        "pattern": "^sha256:[a-f0-9]{64}$"
      },
      "ready": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ui_version",
          "accepted_envelope_versions"
        ],
        "properties": {
          "ui_version": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
          },
          "accepted_envelope_versions": {
            "const": [
              "1.0.0"
            ]
          }
        }
      },
      "init": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "extension_id",
          "api_version",
          "locale",
          "theme",
          "tokens"
        ],
        "properties": {
          "extension_id": {
            "$ref": "#/$defs/id"
          },
          "api_version": {
            "const": "1.0.0"
          },
          "locale": {
            "type": "string",
            "pattern": "^[a-z]{2}(?:-[A-Z]{2})?$"
          },
          "theme": {
            "enum": [
              "apple",
              "apple-dark",
              "awwwards"
            ]
          },
          "tokens": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "surface-0",
              "surface-1",
              "surface-2",
              "text-primary",
              "text-secondary",
              "border-default",
              "border-focus",
              "accent",
              "success-fg",
              "warn-fg",
              "danger-fg",
              "space-2"
            ],
            "properties": {
              "surface-0": {
                "type": "string",
                "maxLength": 64
              },
              "surface-1": {
                "type": "string",
                "maxLength": 64
              },
              "surface-2": {
                "type": "string",
                "maxLength": 64
              },
              "text-primary": {
                "type": "string",
                "maxLength": 64
              },
              "text-secondary": {
                "type": "string",
                "maxLength": 64
              },
              "border-default": {
                "type": "string",
                "maxLength": 64
              },
              "border-focus": {
                "type": "string",
                "maxLength": 64
              },
              "accent": {
                "type": "string",
                "maxLength": 64
              },
              "success-fg": {
                "type": "string",
                "maxLength": 64
              },
              "warn-fg": {
                "type": "string",
                "maxLength": 64
              },
              "danger-fg": {
                "type": "string",
                "maxLength": 64
              },
              "space-2": {
                "type": "string",
                "maxLength": 32
              }
            }
          }
        }
      },
      "dataset": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "dataset_id",
          "envelope"
        ],
        "properties": {
          "dataset_id": {
            "$ref": "#/$defs/id"
          },
          "envelope": {
            "$ref": "https://schemas.nirvana-os.dev/glance/dataset-envelope/1.0.0"
          }
        }
      },
      "refreshing": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "dataset_id"
        ],
        "properties": {
          "dataset_id": {
            "$ref": "#/$defs/id"
          }
        }
      },
      "hostError": {
        "$ref": "https://schemas.nirvana-os.dev/glance/public-error/1.0.0"
      },
      "rendered": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "snapshot_id"
        ],
        "properties": {
          "snapshot_id": {
            "$ref": "#/$defs/digest"
          }
        }
      },
      "extensionError": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "code",
          "message"
        ],
        "properties": {
          "code": {
            "enum": [
              "PAYLOAD_SCHEMA_INVALID",
              "RENDER_FAILED"
            ]
          },
          "message": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        }
      },
      "openExternal": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "request_id",
          "url",
          "display_label"
        ],
        "properties": {
          "request_id": {
            "type": "string",
            "format": "uuid"
          },
          "url": {
            "type": "string",
            "format": "uri",
            "maxLength": 2048
          },
          "display_label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          }
        }
      }
    }
  }
];
// END GENERATED GLANCE SCHEMA DOCUMENTS

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const LOCAL_SCHEMA_PREFIX = "https://schemas.nirvana-os.dev/";
const KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "type", "const", "enum", "allOf", "oneOf", "if", "then",
  "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern", "format", "minimum", "maximum",
]);

function equal(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => equal(item, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
      key === rightKeys[index] && equal(left[key], right[key]));
  }
  return false;
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-](\d{2}):(\d{2}))$/;
function isRfc3339(value) {
  const match = RFC3339.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText), hour = Number(hourText);
  const minute = Number(minuteText), second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) return false;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  const sign = zone.startsWith("+") ? 1 : zone.startsWith("-") ? -1 : 0;
  const base = new Date(0);
  base.setUTCFullYear(year, month - 1, day);
  base.setUTCHours(hour, minute, Math.min(second, 59), 0);
  const milliseconds = base.getTime() - sign * ((offsetHour * 60) + offsetMinute) * 60_000;
  if (!Number.isFinite(milliseconds)) return false;
  if (second === 60) {
    const boundary = new Date(milliseconds);
    const dateAllowed = (boundary.getUTCMonth() === 5 && boundary.getUTCDate() === 30) ||
      (boundary.getUTCMonth() === 11 && boundary.getUTCDate() === 31);
    if (!dateAllowed || boundary.getUTCHours() !== 23 || boundary.getUTCMinutes() !== 59) return false;
  }
  return true;
}

function validateSchema(schema, value, documents, root = schema) {
  if (schema === true) return;
  if (schema === false || root === false) throw new Error("FALSE_SCHEMA");
  if (root === true) root = schema;
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) throw new Error(`UNSUPPORTED_KEYWORD:${key}`);
  if (schema.$schema && schema.$schema !== DIALECT) throw new Error("UNSUPPORTED_DIALECT");
  if (schema.$ref) {
    if (schema.$ref.startsWith("#/$defs/")) {
      const target = root.$defs?.[schema.$ref.slice(8)];
      if (!target) throw new Error("UNKNOWN_LOCAL_REF");
      validateSchema(target, value, documents, root);
    } else {
      if (!schema.$ref.startsWith(LOCAL_SCHEMA_PREFIX)) throw new Error("REMOTE_REF_FORBIDDEN");
      const target = documents.get(schema.$ref);
      if (!target) throw new Error("UNKNOWN_REF");
      validateSchema(target, value, documents, target);
    }
  }
  if (schema.const !== undefined && !equal(schema.const, value)) throw new Error("CONST");
  if (schema.enum && !schema.enum.some((item) => equal(item, value))) throw new Error("ENUM");
  for (const candidate of schema.allOf ?? []) validateSchema(candidate, value, documents, root);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      try { validateSchema(candidate, value, documents, root); return true; } catch { return false; }
    }).length;
    if (matches !== 1) throw new Error("ONE_OF");
  }
  if (schema.if) {
    let matches = false;
    try { validateSchema(schema.if, value, documents, root); matches = true; } catch {}
    if (matches && schema.then) validateSchema(schema.then, value, documents, root);
  }
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && !(schema.type === "integer" ? Number.isInteger(value) : actual === schema.type)) throw new Error(`TYPE:${schema.type}`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) throw new Error("MIN_LENGTH");
    if (schema.maxLength !== undefined && length > schema.maxLength) throw new Error("MAX_LENGTH");
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error("PATTERN");
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("FORMAT:uuid");
    if (schema.format === "date-time" && !isRfc3339(value)) throw new Error("FORMAT:date-time");
    if (schema.format === "uri") {
      try { if (!new URL(value).protocol) throw new Error(); } catch { throw new Error("FORMAT:uri"); }
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error("MINIMUM");
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error("MAXIMUM");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error("MIN_ITEMS");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error("MAX_ITEMS");
    if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some((prior) => equal(item, prior)))) throw new Error("UNIQUE_ITEMS");
    if (schema.items) for (const item of value) validateSchema(schema.items, item, documents, root);
  }
  if (value && actual === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`REQUIRED:${key}`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!schema.properties?.[key]) throw new Error(`ADDITIONAL_PROPERTY:${key}`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in value) validateSchema(child, value[key], documents, root);
  }
}

function walkSchema(schema, root, documents, validateRefs) {
  if (typeof schema === "boolean") return;
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) throw new Error(`UNSUPPORTED_KEYWORD:${key}`);
  if (schema.$schema && schema.$schema !== DIALECT) throw new Error("UNSUPPORTED_DIALECT");
  if (validateRefs && schema.$ref) {
    if (schema.$ref.startsWith("#/$defs/")) {
      if (!root.$defs?.[schema.$ref.slice(8)]) throw new Error("UNKNOWN_LOCAL_REF");
    } else if (!schema.$ref.startsWith(LOCAL_SCHEMA_PREFIX)) throw new Error("REMOTE_REF_FORBIDDEN");
    else if (!documents.has(schema.$ref)) throw new Error("UNKNOWN_REF");
  }
  for (const child of Object.values(schema.$defs ?? {})) walkSchema(child, root, documents, validateRefs);
  for (const child of Object.values(schema.properties ?? {})) walkSchema(child, root, documents, validateRefs);
  for (const child of schema.allOf ?? []) walkSchema(child, root, documents, validateRefs);
  for (const child of schema.oneOf ?? []) walkSchema(child, root, documents, validateRefs);
  if (schema.if) walkSchema(schema.if, root, documents, validateRefs);
  if (schema.then) walkSchema(schema.then, root, documents, validateRefs);
  if (schema.items) walkSchema(schema.items, root, documents, validateRefs);
}

export function createBrowserSchemaRegistry(initialDocuments = BROWSER_SCHEMA_DOCUMENTS) {
  const documents = new Map();
  const addUnchecked = (document) => {
    if (!document?.$id || !document.$id.startsWith(LOCAL_SCHEMA_PREFIX) || documents.has(document.$id)) throw new Error("SCHEMA_ID");
    walkSchema(document, document, documents, false);
    documents.set(document.$id, document);
  };
  for (const document of initialDocuments) addUnchecked(document);
  for (const document of documents.values()) walkSchema(document, document, documents, true);
  return {
    add(document) {
      addUnchecked(document);
      for (const candidate of documents.values()) walkSchema(candidate, candidate, documents, true);
    },
    validate(id, value) {
      const schema = documents.get(id);
      if (!schema) return false;
      try { validateSchema(schema, value, documents); return true; } catch { return false; }
    },
  };
}
