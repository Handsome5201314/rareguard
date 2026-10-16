import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { User } from "../shared/types.js";
import { AppError } from "../server/store.js";
import type { DravetStore } from "./store.js";
import { windowInput } from "./contracts.js";

type IO = { body(req: IncomingMessage): Promise<Record<string, unknown>>; json(res: ServerResponse, status: number, value: unknown): void };
export async function handleDeviceHttp(req: IncomingMessage, res: ServerResponse, path: string, store: DravetStore, io: IO) {
  if (!["/api/dravet/pair", "/api/dravet/batches", "/api/dravet/events"].includes(path)) return false;
  if (req.method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED", "设备接口只接受POST。");
  if (path === "/api/dravet/pair") {
    const input = z.object({ pairingCode: z.string().max(60) }).strict().parse(await io.body(req));
    io.json(res, 201, store.redeem(input.pairingCode));
  } else {
    const token = /^Bearer (dd_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    store.authenticate(token, "device");
    const input = await io.body(req);
    io.json(res, 200, path.endsWith("batches") ? store.ingest(token, input) : store.event(token, input));
  }
  return true;
}
export async function handleParentHttp(req: IncomingMessage, res: ServerResponse, store: DravetStore, user: User, origin: string, io: IO) {
  const url = new URL(req.url ?? "/", origin), match = url.pathname.match(/^\/api\/dravet\/patients\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return false;
  const patientId = z.string().uuid().parse(match[1]), route = match[2], id = match[3];
  store.family.assertChild(user, patientId);
  if (route === "devices" && !id) {
    if (req.method === "GET") { io.json(res, 200, { devices: store.devices(user, patientId) }); return true; }
    if (req.method === "POST") {
      const pair = store.pair(user, patientId, await io.body(req));
      io.json(res, 201, { ...pair, connectionPackage: { kind: "dravet-device-pairing", version: 1, url: origin, pairingCode: pair.pairingCode, deviceId: pair.deviceId, patientId } }); return true;
    }
  }
  if (route === "devices" && id && req.method === "POST") {
    z.object({ consent: z.literal(true) }).strict().parse(await io.body(req));
    const pair = store.renew(user, patientId, z.string().uuid().parse(id));
    io.json(res, 201, { ...pair, connectionPackage: { kind: "dravet-device-pairing", version: 1, url: origin, pairingCode: pair.pairingCode, deviceId: pair.deviceId, patientId } }); return true;
  }
  if (route === "agent-grants" && !id) {
    if (req.method === "GET") { io.json(res, 200, { grants: store.grants(user, patientId) }); return true; }
    if (req.method === "POST") {
      const input = z.object({ name: z.string().trim().min(1).max(80), days: z.number().int().min(1).max(30), consent: z.literal(true) }).strict().parse(await io.body(req));
      const grant = store.grant(user, patientId, input.name, input.days);
      io.json(res, 201, { grant, connectionPackage: { kind: "dravet-monitor-connection", version: 1, url: origin + "/mcp/dravet", token: grant.token } }); return true;
    }
  }
  if (["devices", "agent-grants"].includes(route!) && id && req.method === "DELETE") {
    store.revoke(user, patientId, z.string().uuid().parse(id), route === "devices" ? "device" : "agent"); io.json(res, 200, { ok: true }); return true;
  }
  if (["samples", "events", "summary"].includes(route!) && !id && req.method === "GET") {
    const input = windowInput.parse({ from: url.searchParams.get("from"), to: url.searchParams.get("to"), ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}) });
    io.json(res, 200, route === "summary" ? store.summary(user, patientId, input) : store.read(user, patientId, route as "samples" | "events", input)); return true;
  }
  throw new AppError(404, "NOT_FOUND", "监测接口或方法不存在。");
}
