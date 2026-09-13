// Loaded by the finished-package proof so deterministic work fails closed on
// any attempted network access. The workflow needs only local files and child
// Node processes; saved translation artifacts replace any provider call.

import dns from "node:dns";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const deny = (): never => {
  throw new Error("finished_package_network_access_denied");
};

Object.defineProperty(globalThis, "fetch", { configurable: true, value: deny });
Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class {
  constructor() { deny(); }
} });

for (const [target, names] of [
  [http, ["get", "request"]],
  [https, ["get", "request"]],
  [net, ["connect", "createConnection"]],
  [tls, ["connect"]],
  [dgram, ["createSocket"]],
  [dns, ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]],
] as const) {
  for (const name of names) Object.defineProperty(target, name, { configurable: true, value: deny });
}
