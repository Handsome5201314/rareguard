import { readFile, writeFile, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { User } from "../shared/types.js";
import { AppError, type FamilyStore } from "./store.js";

export const FILE_LIMIT = 8 * 1024 * 1024;
export async function readPrivateAttachment(store: FamilyStore, dataDir: string, user: User, childId: string, id: string, authorize?: () => void) {
  const file = store.getAttachment(user, childId, id), encrypted = await readFile(file.storagePath), key = await readFile(resolve(dataDir, "key.bin"));
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
  decipher.setAAD(Buffer.from(`attachment:${childId}:${id}`)); decipher.setAuthTag(encrypted.subarray(-16));
  const raw = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
  authorize?.(); store.getAttachment(user, childId, id);
  return { filename: file.filename, mime: file.mime, raw };
}

export async function removePrivateAttachment(store: FamilyStore, user: User, childId: string, id: string): Promise<void> {
  const file = store.deleteAttachment(user, childId, id);
  try { await unlink(file.storagePath); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw new AppError(500, "FILE_CLEANUP_REQUIRED", "附件已从列表移除，但文件清理失败。请由管理员检查资料目录。");
  }
}
export async function savePrivateAttachment(store: FamilyStore, dataDir: string, user: User, childId: string, filename: string, mime: string, raw: Buffer, authorize?: () => void) {
  store.assertChild(user, childId);
  const valid = mime === "application/pdf" && raw.subarray(0, 5).toString() === "%PDF-" ||
    mime === "image/png" && raw.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    mime === "image/jpeg" && raw[0] === 255 && raw[1] === 216 && raw[2] === 255;
  if (!raw.length || raw.length > FILE_LIMIT) throw new AppError(413, "FILE_SIZE", "原件须为1字节至8MiB。");
  if (!valid || !filename || filename !== basename(filename) || filename.length > 200 || /[\\/\x00-\x1f\x7f]/.test(filename)) throw new AppError(415, "FILE_TYPE", "仅支持有效的 PDF、PNG、JPEG 和不含路径的文件名。");
  const id = randomUUID(), filePath = resolve(dataDir, "attachments", id + ".bin");
  const key = await readFile(resolve(dataDir, "key.bin")), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("attachment:" + childId + ":" + id));
  const encrypted = Buffer.concat([iv, cipher.update(raw), cipher.final(), cipher.getAuthTag()]);
  await writeFile(filePath, encrypted, { flag: "wx" });
  try { authorize?.(); return store.addAttachment(user, childId, { id, filename, mime, size: raw.length, storagePath: filePath }); }
  catch (error) { await unlink(filePath); throw error; }
}
