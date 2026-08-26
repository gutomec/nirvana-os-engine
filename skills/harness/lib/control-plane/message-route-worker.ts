// message-route-worker.ts — Worker entry of createAgenticMessageRouter: the agenticRoute
// args in, the decision out. The router writes its own audit events (agentic_route_called,
// agentic_route_decision, agentic_route_failed) under the project it is given as cwd.
import { agenticRoute, type AgenticRouteArgs } from "../agentic-router.ts";

declare var self: Worker;

self.onmessage = async (event: MessageEvent<AgenticRouteArgs>) => {
  postMessage(await agenticRoute(event.data));
};
