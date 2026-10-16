import { resolve } from "node:path";
import type { FamilyServerOptions } from "./http.js";

// Relative paths intentionally use the launch directory. The existing deployment
// keeps its environment, encrypted storage and frontend in that directory.
export function familyServerOptions(env: NodeJS.ProcessEnv, cwd = process.cwd(), args: string[] = []): FamilyServerOptions {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--web-root" || !args[1]?.trim())) {
    throw new Error("用法：npm start [-- --web-root <前端构建目录>]。");
  }
  const port = Number(env.FAMILY_PORT ?? 7870);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("FAMILY_PORT 必须为有效端口。");
  const dataDir = env.FAMILY_DATA_DIR ?? "family-data";
  const webRoot = args[1] ?? env.FAMILY_WEB_ROOT;
  if (!dataDir.trim()) throw new Error("FAMILY_DATA_DIR 不能留空。");
  if (webRoot !== undefined && !webRoot.trim()) throw new Error("FAMILY_WEB_ROOT 不能留空；无需网页时请移除此变量。");
  return {
    dataDir: resolve(cwd, dataDir), port,
    ...(webRoot === undefined ? {} : { webRoot: resolve(cwd, webRoot) }),
    publicOrigin: env.FAMILY_PUBLIC_ORIGIN,
    proxyToken: env.FAMILY_PROXY_TOKEN,
  };
}
