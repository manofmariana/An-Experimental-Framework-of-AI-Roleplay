/**
 * 统一临时目录 harness：os.tmpdir() 下 mkdtemp + 自动清理。
 * Windows 下文件锁偶发导致 rm 失败，故 rm 带 maxRetries/retryDelay。
 * 传 TestContext（it/describe 回调的 t）→ t.after 随测试清理；
 * 不传 → 模块级 after，随所在文件套件结束清理（适合全文件共享一个根的场景）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, type TestContext } from "node:test";

/** 递归删除临时目录（Windows 文件锁重试）。 */
export function rmWithRetry(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** 创建临时目录并注册自动清理；返回目录路径。 */
export function tempDir(prefix = "airp-", t?: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (t) {
    t.after(() => rmWithRetry(dir));
  } else {
    after(() => rmWithRetry(dir));
  }
  return dir;
}
