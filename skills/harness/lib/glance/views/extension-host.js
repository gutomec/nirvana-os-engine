import { createBrowserSchemaRegistry } from "./extension-message-schema-registry.js";
import { createMessageValidator } from "./extension-message-validator.js";

const BOOTSTRAP = Object.freeze({
  schema_version: "1.0.0",
  protocol: "glance.extension.messages",
  type: "extension.bootstrap",
});
const CONNECT = Object.freeze({
  schema_version: "1.0.0",
  protocol: "glance.extension.messages",
  type: "host.connect",
});
const THEMES = new Set(["apple", "apple-dark", "awwwards"]);
const TIMEOUT_MS = 5_000;

function exactPacket(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) =>
    key === expectedKeys[index] && value[key] === expected[key]);
}

function newSession(cryptoObject) {
  const bytes = new Uint8Array(32);
  cryptoObject.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function hasExactGitHubAuthority(value) {
  if (typeof value !== "string") return false;
  const match = /^https:\/\/([^/?#]*)(?:[/?#]|$)/.exec(value);
  return Boolean(match && /^[A-Za-z0-9.-]+$/.test(match[1]) && match[1].toLowerCase() === "github.com");
}

function validActivation(event, runtime) {
  if (!event?.isTrusted || event.currentTarget !== runtime.confirmControl || !runtime.hostRoot.contains(event.currentTarget)) return false;
  if (event.type === "click" || event.type === "pointerup") return true;
  return event.type === "keydown" && (event.key === "Enter" || event.key === " ");
}

export class ExtensionHostController {
  constructor(runtime) {
    this.runtime = runtime;
    this.pending = null;
  }

  requestOpen(url, displayLabel, requestId) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("URL_REJECTED"); }
    if (!hasExactGitHubAuthority(url) || parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password ||
      parsed.hash || parsed.port || !this.runtime.manifestHosts.includes("github.com") ||
      !this.runtime.coreHosts.includes("github.com")) throw new Error("URL_REJECTED");
    this.pending = { url: parsed.href, displayLabel, requestId, created: this.runtime.monotonicNow() };
    if (this.runtime.pendingTarget) this.runtime.pendingTarget.textContent = `${displayLabel} (github.com)`;
    if (this.runtime.navigationTarget) this.runtime.navigationTarget.hidden = false;
    if (this.runtime.confirmControl) this.runtime.confirmControl.hidden = false;
    if (this.runtime.cancelControl) this.runtime.cancelControl.hidden = false;
    this.runtime.confirmControl?.focus?.();
    return true;
  }

  clearPending() {
    this.pending = null;
    if (this.runtime.pendingTarget) this.runtime.pendingTarget.textContent = "";
    if (this.runtime.navigationTarget) this.runtime.navigationTarget.hidden = true;
    if (this.runtime.confirmControl) this.runtime.confirmControl.hidden = true;
    if (this.runtime.cancelControl) this.runtime.cancelControl.hidden = true;
  }

  cancel() {
    this.clearPending();
    return false;
  }

  confirm(event) {
    const pending = this.pending;
    if (!pending || !validActivation(event, this.runtime)) return false;
    this.clearPending();
    if (this.runtime.monotonicNow() - pending.created > 30_000) {
      this.runtime.audit({ event: "external_open_expired", request_id: pending.requestId });
      return false;
    }
    const opened = this.runtime.open(pending.url, "_blank", "noopener,noreferrer");
    if (!opened) {
      this.runtime.audit({ event: "external_open_failed", request_id: pending.requestId });
      return false;
    }
    opened.opener = null;
    this.runtime.audit({ event: "external_open_confirmed", request_id: pending.requestId, monotonic_ms: this.runtime.monotonicNow() });
    return true;
  }

  renderText(value) { this.runtime.textTarget.textContent = String(value); }
  renderStatus(value) { this.runtime.statusTarget.textContent = String(value); }
}

export function mountExtensionHost(options) {
  if (!options?.iframe?.contentWindow) throw new TypeError("iframe contentWindow required");
  if (!THEMES.has(options.theme)) throw new TypeError("theme invalid");
  const windowTarget = options.windowTarget ?? window;
  const cryptoObject = options.cryptoObject ?? crypto;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const channel = (options.messageChannelFactory ?? (() => new MessageChannel()))();
  const sessionId = newSession(cryptoObject);
  const schemaRegistry = options.schemaRegistry ?? createBrowserSchemaRegistry();
  const validateMessage = createMessageValidator(schemaRegistry);
  const audit = options.audit ?? (() => {});
  const startedAt = monotonicNow();
  let state = "bootstrapping";
  let bootstrapped = false;
  let expectedInbound = 0;
  let nextOutbound = 0;
  let inboundDeliveries = 0;
  let terminal = false;
  let bootstrapTimer;
  let readyTimer;

  const opener = new ExtensionHostController({
    manifestHosts: options.manifestHosts ?? [], coreHosts: options.coreHosts ?? ["github.com"],
    hostRoot: options.hostRoot,
    confirmControl: options.confirmControl, cancelControl: options.cancelControl,
    navigationTarget: options.navigationTarget, pendingTarget: options.pendingTarget,
    textTarget: options.textTarget, statusTarget: options.statusTarget,
    monotonicNow, audit, open: options.open ?? ((...args) => window.open(...args)),
  });
  const onConfirmClick = (event) => opener.confirm(event);
  const onConfirmKeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault?.();
      opener.confirm(event);
    }
  };
  const onCancelClick = () => opener.cancel();
  const onHostKeydown = (event) => {
    if (event.key !== "Escape" || !opener.pending) return;
    event.preventDefault?.();
    opener.cancel();
    options.returnFocusTarget?.focus?.();
  };

  const cleanup = () => {
    windowTarget.removeEventListener("message", onWindowMessage);
    windowTarget.removeEventListener("keydown", onHostKeydown);
    options.confirmControl?.removeEventListener?.("click", onConfirmClick);
    options.confirmControl?.removeEventListener?.("keydown", onConfirmKeydown);
    options.cancelControl?.removeEventListener?.("click", onCancelClick);
    if (bootstrapTimer !== undefined) clearTimer(bootstrapTimer);
    if (readyTimer !== undefined) clearTimer(readyTimer);
    channel.port1.onmessage = null;
    channel.port1.onmessageerror = null;
    try { channel.port1.close(); } catch {}
    try { channel.port2.close(); } catch {}
    opener.cancel();
  };

  const reject = (sequence = -1) => {
    if (terminal) return false;
    terminal = true;
    state = "rejected";
    audit({ event: "extension_message_rejected", sequence: Number.isSafeInteger(sequence) ? sequence : -1 });
    cleanup();
    return false;
  };

  const sendPacket = (type, payload) => {
    if (terminal || !bootstrapped) return false;
    const packet = { schema_version: "1.0.0", protocol: "glance.extension.messages", session_id: sessionId, sequence: nextOutbound, type, payload };
    if (!validateMessage(packet, sessionId, "host-to-extension", nextOutbound)) return reject(nextOutbound);
    channel.port1.postMessage(packet);
    nextOutbound++;
    return true;
  };

  const onPortMessage = (event) => {
    if (terminal) return;
    inboundDeliveries++;
    const packet = event.data;
    const sequence = Number.isSafeInteger(packet?.sequence) ? packet.sequence : -1;
    if (!validateMessage(packet, sessionId, "extension-to-host", expectedInbound)) return reject(sequence);
    if (expectedInbound === 0 && packet.type !== "extension.ready") return reject(sequence);
    if (expectedInbound > 0 && packet.type === "extension.ready") return reject(sequence);
    expectedInbound++;
    if (packet.type === "extension.ready") {
      if (readyTimer !== undefined) clearTimer(readyTimer);
      state = "active";
      options.onActive?.(api);
      return;
    }
    if (packet.type === "extension.open_external_url") {
      try { opener.requestOpen(packet.payload.url, packet.payload.display_label, packet.payload.request_id); }
      catch { reject(sequence); }
    } else if (packet.type === "extension.rendered") {
      opener.renderStatus(`Rendered ${packet.payload.snapshot_id}`);
    } else if (packet.type === "extension.error") {
      opener.renderStatus(packet.payload.message);
    }
  };

  function onWindowMessage(event) {
    if (terminal) return;
    const sequence = Number.isSafeInteger(event?.data?.sequence) ? event.data.sequence : -1;
    if (event.source !== options.iframe.contentWindow || event.origin !== "null") return reject(sequence);
    if (!exactPacket(event.data, BOOTSTRAP) || bootstrapped || monotonicNow() - startedAt > TIMEOUT_MS) return reject(sequence);
    bootstrapped = true;
    state = "connecting";
    if (bootstrapTimer !== undefined) clearTimer(bootstrapTimer);
    channel.port1.onmessage = onPortMessage;
    channel.port1.onmessageerror = () => reject(-1);
    channel.port1.start?.();
    options.iframe.contentWindow.postMessage(CONNECT, "*", [channel.port2]);
    const initSent = sendPacket("host.init", {
      extension_id: options.extensionId,
      api_version: "1.0.0",
      locale: options.locale,
      theme: options.theme,
      tokens: options.tokens,
    });
    if (!initSent) return;
    readyTimer = setTimer(() => reject(-1), TIMEOUT_MS);
  }

  const close = (reason = "host_shutdown") => {
    if (terminal) return false;
    terminal = true;
    state = "closed";
    audit({ event: "extension_channel_closed", reason });
    cleanup();
    return true;
  };

  const api = {
    sessionId,
    state: () => state,
    inboundDeliveries: () => inboundDeliveries,
    sendDataset: (datasetId, envelope) => sendPacket("host.dataset", { dataset_id: datasetId, envelope }),
    sendRefreshing: (datasetId) => sendPacket("host.refreshing", { dataset_id: datasetId }),
    sendError: (error) => sendPacket("host.error", error),
    close,
    opener,
  };

  options.confirmControl?.addEventListener?.("click", onConfirmClick);
  options.confirmControl?.addEventListener?.("keydown", onConfirmKeydown);
  options.cancelControl?.addEventListener?.("click", onCancelClick);
  windowTarget.addEventListener("message", onWindowMessage);
  windowTarget.addEventListener("keydown", onHostKeydown);
  bootstrapTimer = setTimer(() => reject(-1), TIMEOUT_MS);
  return api;
}

export { BOOTSTRAP as EXTENSION_BOOTSTRAP_PACKET, CONNECT as HOST_CONNECT_PACKET };
