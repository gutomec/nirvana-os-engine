export interface IframeRequestObservation { eventTrusted: boolean; eventType: "click"; frameId: string; targetFrameId: string; messageType: "extension.open_external_url"; cdpSessionId: string }
export interface BrowserVersionObservation { product: string; revision: string; userAgent: string; jsVersion: string; protocolVersion: string; cdpSessionId: string }
export interface BrowserProbe {
  browserVersion(): Promise<BrowserVersionObservation>;
  requestFromIframe(): Promise<IframeRequestObservation>;
  confirmPointer(): Promise<void>;
  confirmKeyboard(key: "Enter" | " "): Promise<void>;
  cancelPointer(): Promise<void>;
  confirmSynthetic(): Promise<void>;
  advanceMonotonic(ms: number): Promise<void>;
  setOpenMode(mode: "normal" | "failure"): Promise<void>;
  pageCount(): Promise<number>;
  closePopups(): Promise<void>;
  failureReported(): Promise<boolean>;
  openerWasNull(): Promise<boolean>;
  baseline(): Promise<{ pwned: false; cards759: "grid"; table759: "none"; cards760: "none"; table760: "table"; focusOutlineStyle: "solid"; statusText: "Snapshot expired"; iframeSandbox: "allow-scripts"; hostControlOutsideIframe: true }>;
}

async function openedBy(probe: BrowserProbe, action: () => Promise<void>) {
  const before = await probe.pageCount();
  await action();
  await Bun.sleep(150);
  const opened = (await probe.pageCount()) - before;
  await probe.closePopups();
  return opened;
}

export async function runBrowserContract(probe: BrowserProbe) {
  const version = await probe.browserVersion();
  const observed = await probe.requestFromIframe();
  const versionFields = [version.product, version.revision, version.userAgent, version.jsVersion, version.protocolVersion];
  if (versionFields.some((value) => typeof value !== "string" || value.trim() === "")) throw new Error("BROWSER_VERSION_INCOMPLETE");
  if (!version.cdpSessionId || version.cdpSessionId !== observed.cdpSessionId) throw new Error("BROWSER_CDP_SESSION_MISMATCH");
  if (!observed.frameId || !observed.targetFrameId || !observed.eventTrusted || observed.eventType !== "click" || observed.messageType !== "extension.open_external_url") throw new Error("IFRAME_REQUEST_NOT_OBSERVED");
  if (observed.frameId !== observed.targetFrameId) throw new Error("IFRAME_FRAME_MISMATCH");
  const iframeTrustedOpened = await openedBy(probe, () => probe.confirmPointer());
  await probe.requestFromIframe(); await probe.cancelPointer();
  const cancelOpened = await openedBy(probe, () => probe.confirmPointer());
  await probe.requestFromIframe(); await probe.advanceMonotonic(30_001);
  const expiredOpened = await openedBy(probe, () => probe.confirmPointer());
  await probe.requestFromIframe(); await probe.setOpenMode("failure");
  const failedOpenOpened = await openedBy(probe, () => probe.confirmPointer());
  const failureReported = await probe.failureReported();
  await probe.setOpenMode("normal"); await probe.requestFromIframe();
  const trustedEnterOpened = await openedBy(probe, () => probe.confirmKeyboard("Enter"));
  await probe.requestFromIframe();
  const trustedSpaceOpened = await openedBy(probe, () => probe.confirmKeyboard(" "));
  await probe.requestFromIframe();
  const syntheticOpened = await openedBy(probe, () => probe.confirmSynthetic());
  const openerIsNull = await probe.openerWasNull();
  const baseline = await probe.baseline();
  return {
    browserProduct: version.product, browserRevision: version.revision, browserUserAgent: version.userAgent,
    browserJsVersion: version.jsVersion, browserProtocolVersion: version.protocolVersion,
    browserVersionCdpSessionId: version.cdpSessionId, assertionCdpSessionId: observed.cdpSessionId,
    iframeRequestTrusted: observed.eventTrusted, iframeRequestEventType: observed.eventType,
    iframeRequestFrameId: observed.frameId, iframeTargetFrameId: observed.targetFrameId,
    iframeRequestFrameMatches: observed.frameId === observed.targetFrameId,
    iframeTrustedOpened, cancelOpened, expiredOpened, failedOpenOpened, failureReported, syntheticOpened,
    trustedPointerOpened: iframeTrustedOpened, trustedEnterOpened, trustedSpaceOpened, openerIsNull, ...baseline,
  };
}
