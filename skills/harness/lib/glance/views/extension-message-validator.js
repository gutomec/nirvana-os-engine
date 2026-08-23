const MESSAGE_SCHEMA_ID = "https://schemas.nirvana-os.dev/glance/message/1.0.0";
const HOST_TYPES = new Set(["host.init", "host.dataset", "host.refreshing", "host.error"]);
const EXTENSION_TYPES = new Set(["extension.ready", "extension.rendered", "extension.error", "extension.open_external_url"]);
const TOKEN_LIMITS = Object.freeze({
  "surface-0": 64, "surface-1": 64, "surface-2": 64,
  "text-primary": 64, "text-secondary": 64,
  "border-default": 64, "border-focus": 64, accent: 64,
  "success-fg": 64, "warn-fg": 64, "danger-fg": 64, "space-2": 32,
});

function validTokenValues(packet) {
  if (packet.type !== "host.init") return true;
  const tokens = packet.payload?.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return false;
  const keys = Object.keys(tokens);
  if (keys.length !== Object.keys(TOKEN_LIMITS).length) return false;
  return Object.entries(TOKEN_LIMITS).every(([key, maximum]) =>
    typeof tokens[key] === "string" && [...tokens[key]].length > 0 && [...tokens[key]].length <= maximum);
}

export function createMessageValidator(schemaRegistry) {
  if (!schemaRegistry || typeof schemaRegistry.validate !== "function") throw new TypeError("schema registry required");
  return function validateMessage(packet, expectedSession, direction, expectedSequence) {
    if (direction !== "host-to-extension" && direction !== "extension-to-host") return false;
    const types = direction === "host-to-extension" ? HOST_TYPES : EXTENSION_TYPES;
    try {
      return packet !== null && typeof packet === "object" && !Array.isArray(packet) &&
        packet.session_id === expectedSession && packet.sequence === expectedSequence &&
        types.has(packet.type) && validTokenValues(packet) &&
        schemaRegistry.validate(MESSAGE_SCHEMA_ID, packet) === true;
    } catch {
      return false;
    }
  };
}

export { MESSAGE_SCHEMA_ID, TOKEN_LIMITS };
