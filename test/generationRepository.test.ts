import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  GenerationRepository,
  formatRevision,
  TRUTH_FILES,
  type RepoIo,
  type SaveSet,
} from "../src/truth/generationRepository.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import { RevisionConflictError, SaveLoadError, type SaveLoadErrorKind } from "../src/truth/validation/errors.js";
import { buildEvent, buildPromptsFile, buildSysFile, buildWorldTree } from "./builders/index.js";
import { tempDir } from "./harness/tempDir.js";

// ---------------------------------------------------------------------------
// GenerationRepository（CURRENT + generations/{rev}/ 七文件，单一写盘屏障；
// 原子提交 = 临时目录 → 重读校验 → rename → CURRENT.tmp rename；灾备回退上一代）。
// contract 层：真实临时文件系统 + RepoIo 故障注入。
// ---------------------------------------------------------------------------

function sampleSave(marker: string): SaveSet {
  return {
    world: { ...buildWorldTree(), note: marker },
    sys: buildSysFile(),
    characters: {},
    events: [],
    archive: [],
    lores: { entries: [], changelog: [] },
    prompts: buildPromptsFile(),
  };
}

/** 断言抛 SaveLoadError 且 kind 命中（可选措辞正则）。 */
function expectKind(fn: () => unknown, kind: SaveLoadErrorKind, pattern?: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof SaveLoadError, `应为 SaveLoadError，实为 ${String(error)}`);
    assert.equal(error.kind, kind, `kind 应为 ${kind}：${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------
// RepoIo 故障注入：包装 node fs，arm 后对指定方法的第 N 次调用（arm 后计数）抛错。
// ---------------------------------------------------------------------------

interface FailSpec {
  method: keyof RepoIo;
  /** arm 后第 N 次调用失败；缺省 = 每次都失败 */
  onCall?: number;
  /** 额外调用条件（如按路径区分 CURRENT.tmp 与 Generation 内文件） */
  when?: (args: readonly unknown[]) => boolean;
  error?: Error;
}

function makeFailingIo(): { io: RepoIo; arm: (spec: FailSpec) => void; disarm: () => void } {
  let spec: FailSpec | null = null;
  const counts = new Map<string, number>();
  const armedAt = new Map<string, number>();
  const wrap = <K extends keyof RepoIo>(method: K): RepoIo[K] => {
    const original = fs[method] as unknown as (...args: unknown[]) => unknown;
    const wrapped = (...args: unknown[]): unknown => {
      const n = (counts.get(method) ?? 0) + 1;
      counts.set(method, n);
      if (
        spec &&
        spec.method === method &&
        (spec.onCall === undefined || spec.onCall === n - (armedAt.get(method) ?? 0)) &&
        (spec.when === undefined || spec.when(args))
      ) {
        throw spec.error ?? new Error(`injected ${method}#${n}`);
      }
      return original(...args);
    };
    return wrapped as unknown as RepoIo[K];
  };
  return {
    io: {
      writeFileSync: wrap("writeFileSync"),
      renameSync: wrap("renameSync"),
      mkdirSync: wrap("mkdirSync"),
      rmSync: wrap("rmSync"),
      readFileSync: wrap("readFileSync"),
      existsSync: wrap("existsSync"),
      readdirSync: wrap("readdirSync"),
    },
    arm: (s) => {
      spec = s;
      armedAt.set(s.method, counts.get(s.method) ?? 0);
    },
    disarm: () => {
      spec = null;
    },
  };
}

/** CURRENT + generations/000001/ 全部文件逐字节快照。 */
function snapshotRun(dir: string): Map<string, string> {
  const snap = new Map<string, string>();
  snap.set("CURRENT", fs.readFileSync(path.join(dir, "CURRENT"), "utf8"));
  const genDir = path.join(dir, "generations", "000001");
  for (const file of fs.readdirSync(genDir)) {
    snap.set(path.join("generations", "000001", file), fs.readFileSync(path.join(genDir, file), "utf8"));
  }
  return snap;
}

function assertSnapshotUnchanged(dir: string, snap: Map<string, string>): void {
  for (const [rel, content] of snap) {
    assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), content, `${rel} 不应变化`);
  }
}

/** 捕获 console.warn 输出（灾备/清理告警断言用）。 */
function captureWarn(run: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

describe("GenerationRepository（布局与提交）", () => {
  it("空目录 exists()=false；loadCurrent → incomplete", () => {
    const repo = new GenerationRepository(tempDir("airp-gen-"));
    assert.equal(repo.exists(), false);
    expectKind(() => repo.loadCurrent(), "incomplete", /缺 CURRENT/);
  });

  it("commit → Generation 1（CURRENT 指向）；再 commit → revision 2 且字典序=数值序", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);

    const rev1 = repo.commit(0, sampleSave("一"));
    assert.equal(rev1, 1);
    assert.equal(fs.readFileSync(path.join(dir, "CURRENT"), "utf8"), "000001");
    assert.equal(formatRevision(7), "000007");
    for (const file of TRUTH_FILES) {
      assert.ok(fs.existsSync(path.join(dir, "generations", "000001", file)), `缺 ${file}`);
    }

    const rev2 = repo.commit(rev1, sampleSave("二"));
    assert.equal(rev2, 2);
    assert.equal(fs.readFileSync(path.join(dir, "CURRENT"), "utf8"), "000002");
    assert.equal(repo.currentRevision(), 2);
    assert.equal(repo.exists(), true);
  });

  it("loadCurrent 七文件回环（SaveSet 逐字段一致；信封版本统一）", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    const save = sampleSave("回环");
    repo.commit(0, save);

    const loaded = repo.loadCurrent();
    assert.equal(loaded.revision, 1);
    assert.equal(loaded.recoveredFrom, undefined, "正常加载无灾备标记");
    assert.deepEqual(loaded.save, save);
    // 信封：schema_version 单点化——只有 sys.json 盖章，其余文件不携版本字面量
    const sysRaw = JSON.parse(
      fs.readFileSync(path.join(dir, "generations", "000001", "sys.json"), "utf8"),
    ) as { schema_version: unknown };
    assert.equal(sysRaw.schema_version, SAVE_SCHEMA_VERSION, "sys.json 版本盖章");
    for (const file of TRUTH_FILES) {
      if (file === "sys.json") continue;
      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, "generations", "000001", file), "utf8"),
      ) as { schema_version?: unknown };
      assert.equal(raw.schema_version, undefined, `${file} 不再盖章`);
    }
  });

  it("旧平铺布局（平铺真相文件之一在 run 根且无 CURRENT）→ version（提示新建会话）", () => {
    const dir = tempDir("airp-gen-");
    fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({ schema_version: 5 }));
    const repo = new GenerationRepository(dir);
    assert.equal(repo.exists(), false);
    expectKind(() => repo.assertNoLegacyFlat(), "version", /请新建会话\/重启服务/);
    // loadCurrent 本身只见"缺 CURRENT"：incomplete（旧平铺识别归 assertNoLegacyFlat）
    expectKind(() => repo.loadCurrent(), "incomplete", /缺 CURRENT/);
  });
});

describe("原子提交（RepoIo 故障注入）", () => {
  it("写临时目录中途 throw → CURRENT 与旧 Generation 逐字节不变，revision 不变；.tmp 残留下次构造被清理", () => {
    const dir = tempDir("airp-gen-");
    const failing = makeFailingIo();
    const repo = new GenerationRepository(dir, { io: failing.io });
    repo.commit(0, sampleSave("一"));
    const before = snapshotRun(dir);

    failing.arm({ method: "writeFileSync", onCall: 3 }); // 七文件的第 3 个写入失败
    expectKind(() => repo.commit(1, sampleSave("二")), "io");
    failing.disarm();

    assertSnapshotUnchanged(dir, before);
    assert.equal(repo.currentRevision(), 1, "revision 不前移");
    // 临时目录残留可见，下次构造（进程重启语义）被清理
    const residue = path.join(dir, "generations", ".tmp-000002");
    assert.ok(fs.existsSync(residue), "崩溃残留的临时目录");
    new GenerationRepository(dir);
    assert.ok(!fs.existsSync(residue), "构造时清理 .tmp-* 残留");
    assert.equal(repo.currentRevision(), 1);
  });

  it("rename 前 throw（重读校验阶段失败）→ 旧态逐字节不变 + .tmp 残留被下次构造清理", () => {
    const dir = tempDir("airp-gen-");
    const failing = makeFailingIo();
    const repo = new GenerationRepository(dir, { io: failing.io });
    repo.commit(0, sampleSave("一"));
    const before = snapshotRun(dir);

    failing.arm({ method: "renameSync", onCall: 1 }); // .tmp-{next} → {next} 的确认 rename
    expectKind(() => repo.commit(1, sampleSave("二")), "io");
    failing.disarm();

    assertSnapshotUnchanged(dir, before);
    assert.equal(repo.currentRevision(), 1);
    const residue = path.join(dir, "generations", ".tmp-000002");
    assert.ok(fs.existsSync(residue));
    new GenerationRepository(dir);
    assert.ok(!fs.existsSync(residue));
  });

  it("CURRENT 写入 throw → Generation 已建但 CURRENT 未切换，loadCurrent 仍旧 revision", () => {
    const dir = tempDir("airp-gen-");
    const failing = makeFailingIo();
    const repo = new GenerationRepository(dir, { io: failing.io });
    repo.commit(0, sampleSave("一"));
    const before = snapshotRun(dir);

    failing.arm({ method: "writeFileSync", when: (args) => String(args[0]).endsWith("CURRENT.tmp") });
    expectKind(() => repo.commit(1, sampleSave("二")), "io");
    failing.disarm();

    assertSnapshotUnchanged(dir, before);
    assert.ok(fs.existsSync(path.join(dir, "generations", "000002")), "Generation 已确认但指针未切换（外部仍只见旧态）");
    assert.equal(repo.loadCurrent().revision, 1);
  });

  it("baseRevision 过期 → RevisionConflictError（携带 base/current 双值）", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    assert.throws(
      () => repo.commit(0, sampleSave("二")),
      (error: unknown) => {
        assert.ok(error instanceof RevisionConflictError, `应为 RevisionConflictError，实为 ${String(error)}`);
        assert.equal(error.base, 0);
        assert.equal(error.current, 1);
        return true;
      },
    );
    assert.equal(repo.currentRevision(), 1);
  });

  it("validateSaveSet 钩子抛错 → 提交否决（invariant 类），旧态逐字节不变", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    const before = snapshotRun(dir);

    const guarded = new GenerationRepository(dir, {
      validateSaveSet: () => {
        throw new SaveLoadError("invariant", "跨文件不变量不满足（测试桩）");
      },
    });
    expectKind(() => guarded.commit(1, sampleSave("二")), "invariant", /跨文件不变量/);
    assertSnapshotUnchanged(dir, before);
    assert.equal(repo.currentRevision(), 1);
  });

  it("连续 4 次 commit 后只剩 current+previous 两个 Generation 目录", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    repo.commit(1, sampleSave("二"));
    repo.commit(2, sampleSave("三"));
    repo.commit(3, sampleSave("四"));

    const entries = fs
      .readdirSync(path.join(dir, "generations"))
      .filter((entry) => /^\d{6}$/.test(entry))
      .sort();
    assert.deepEqual(entries, ["000003", "000004"], "只保留 current 与 previous");
    assert.equal(repo.currentRevision(), 4);
  });

  it("清理 rmSync throw → commit 仍成功返回（清理失败只告警，不报事务失败）", () => {
    const dir = tempDir("airp-gen-");
    const failing = makeFailingIo();
    const repo = new GenerationRepository(dir, { io: failing.io });
    repo.commit(0, sampleSave("一"));
    repo.commit(1, sampleSave("二"));

    failing.arm({ method: "rmSync" }); // 清理阶段全部 rm 失败
    let rev = 0;
    const warnings = captureWarn(() => {
      rev = repo.commit(2, sampleSave("三"));
    });
    failing.disarm();

    assert.equal(rev, 3, "清理失败不影响已切换的事务");
    assert.equal(fs.readFileSync(path.join(dir, "CURRENT"), "utf8"), "000003");
    assert.ok(warnings.some((line) => /存档清理/.test(line)), "清理失败有告警");
    assert.ok(fs.existsSync(path.join(dir, "generations", "000001")), "旧代因清理失败残留（无害）");
  });
});

describe("loadCurrent 灾备回退", () => {
  it("当前 Generation 文件损坏（corrupt）→ 回退上一代 + recoveredFrom + 告警", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    repo.commit(1, sampleSave("二"));
    fs.writeFileSync(path.join(dir, "generations", "000002", "events.json"), "{ 截断");

    let loaded: ReturnType<GenerationRepository["loadCurrent"]> | undefined;
    const warnings = captureWarn(() => {
      loaded = repo.loadCurrent();
    });
    assert.equal(loaded?.revision, 1, "回退到上一代");
    assert.equal(loaded?.recoveredFrom, 2, "标记坏掉的 revision");
    assert.equal(loaded?.save.world["note"], "一");
    assert.ok(warnings.some((line) => /存档灾备.*回退上一代/.test(line)), "明确报告恢复行为");
  });

  it("当前 Generation 缺文件（incomplete）→ 同样回退上一代", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    repo.commit(1, sampleSave("二"));
    fs.rmSync(path.join(dir, "generations", "000002", "archive.json"));

    let loaded: ReturnType<GenerationRepository["loadCurrent"]> | undefined;
    const warnings = captureWarn(() => {
      loaded = repo.loadCurrent();
    });
    assert.equal(loaded?.revision, 1);
    assert.equal(loaded?.recoveredFrom, 2);
    assert.ok(warnings.some((line) => /存档灾备/.test(line)));
  });

  it("上一代也坏 → 抛原始错误（不二次掩盖）", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    repo.commit(1, sampleSave("二"));
    fs.writeFileSync(path.join(dir, "generations", "000002", "events.json"), "{ 截断");
    fs.writeFileSync(path.join(dir, "generations", "000001", "events.json"), "{ 截断");

    captureWarn(() => expectKind(() => repo.loadCurrent(), "corrupt", /events\.json/));
  });

  it("version 错误不回退（旧版本上一代必然同版，回退无意义）", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    repo.commit(1, sampleSave("二"));
    // 版本闸单点化：schema_version 只读 sys.json 一处
    const file = path.join(dir, "generations", "000002", "sys.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { schema_version: number };
    raw.schema_version = SAVE_SCHEMA_VERSION - 1;
    fs.writeFileSync(file, JSON.stringify(raw));
    expectKind(() => repo.loadCurrent(), "version", /请新建会话\/重启服务/);
  });

  it("旧布局 Generation（缺 sys.json）→ version（旧档不迁移）", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    fs.rmSync(path.join(dir, "generations", "000001", "sys.json"));
    expectKind(() => repo.loadCurrent(), "version", /请新建会话\/重启服务/);
  });

  it("loadPrevious() 显式灾备读取：有上一代返回之，无上一代 → not_found", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    expectKind(() => repo.loadPrevious(), "not_found", /Generation 不存在/);
    repo.commit(1, sampleSave("二"));
    const previous = repo.loadPrevious();
    assert.equal(previous.revision, 1);
    assert.equal(previous.save.world["note"], "一");
  });
});

describe("类型化加载错误（SaveLoadError 六类）", () => {
  it("not_found：run 目录不存在 / CURRENT 指向不存在的 Generation", () => {
    const dir = tempDir("airp-gen-");
    const missing = new GenerationRepository(path.join(dir, "no-such-run"));
    expectKind(() => missing.loadCurrent(), "not_found", /存档不存在/);

    fs.writeFileSync(path.join(dir, "CURRENT"), "000007");
    const dangling = new GenerationRepository(dir);
    expectKind(() => dangling.loadCurrent(), "not_found", /Generation 不存在/);
  });

  it("incomplete：缺 CURRENT / CURRENT 不可解析 / Generation 内缺文件", () => {
    const dirNoCurrent = tempDir("airp-gen-");
    expectKind(() => new GenerationRepository(dirNoCurrent).loadCurrent(), "incomplete", /缺 CURRENT/);

    const dirBad = tempDir("airp-gen-");
    fs.writeFileSync(path.join(dirBad, "CURRENT"), "not-a-number");
    const repoBad = new GenerationRepository(dirBad);
    assert.equal(repoBad.exists(), false);
    expectKind(() => repoBad.loadCurrent(), "incomplete", /CURRENT 内容不可解析/);

    const dirMissing = tempDir("airp-gen-");
    const repoMissing = new GenerationRepository(dirMissing);
    repoMissing.commit(0, sampleSave("x"));
    fs.rmSync(path.join(dirMissing, "generations", "000001", "archive.json"));
    expectKind(() => repoMissing.loadCurrent(), "incomplete", /缺核心文件/);
  });

  it("version：sys.json 版本字面量不符（措辞保留请新建会话）/ 旧平铺档", () => {
    const dirMixed = tempDir("airp-gen-");
    const repoMixed = new GenerationRepository(dirMixed);
    repoMixed.commit(0, sampleSave("x"));
    const file = path.join(dirMixed, "generations", "000001", "sys.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { schema_version: number };
    raw.schema_version = SAVE_SCHEMA_VERSION - 1;
    fs.writeFileSync(file, JSON.stringify(raw));
    expectKind(() => repoMixed.loadCurrent(), "version", /请新建会话\/重启服务/);

    const dirLegacy = tempDir("airp-gen-");
    fs.writeFileSync(path.join(dirLegacy, "world.json"), JSON.stringify({ schema_version: 5 }));
    expectKind(() => new GenerationRepository(dirLegacy).assertNoLegacyFlat(), "version", /请新建会话\/重启服务/);
  });

  it("corrupt：JSON 截断 / 当前版本下单文件结构损坏", () => {
    const dirTruncated = tempDir("airp-gen-");
    const repoTruncated = new GenerationRepository(dirTruncated);
    repoTruncated.commit(0, sampleSave("x"));
    fs.writeFileSync(path.join(dirTruncated, "generations", "000001", "lores.json"), "{ 截断");
    expectKind(() => repoTruncated.loadCurrent(), "corrupt", /JSON 不可解析/);

    const dirBroken = tempDir("airp-gen-");
    const repoBroken = new GenerationRepository(dirBroken);
    repoBroken.commit(0, sampleSave("x"));
    fs.writeFileSync(
      path.join(dirBroken, "generations", "000001", "events.json"),
      JSON.stringify({ events: "不是数组" }),
    );
    expectKind(() => repoBroken.loadCurrent(), "corrupt", /结构校验失败/);
  });

  it("io：系统错误（EACCES 等）原样归类并带 code 详情", () => {
    const dir = tempDir("airp-gen-");
    const failing = makeFailingIo();
    const repo = new GenerationRepository(dir, { io: failing.io });
    failing.arm({ method: "readFileSync", error: Object.assign(new Error("access denied"), { code: "EACCES" }) });
    expectKind(() => repo.loadCurrent(), "io", /EACCES/);
    failing.disarm();
  });
});

describe("validateSaveSet 默认接入（B4 两级校验）", () => {
  it("commit invariant 冲突的 SaveSet（默认校验器）→ 抛 invariant，CURRENT 不切换、Generation 不确认", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    const before = snapshotRun(dir);

    // 七文件 codec 各自合法，但 current=null 时 archive 非空（跨文件不变量矛盾）
    const broken = sampleSave("二");
    broken.archive = [{ seq: 1, kind: "gm", result: null, changes: { setup: [], effects: [] } }];
    expectKind(() => repo.commit(1, broken), "invariant", /archive 必须为空/);

    assertSnapshotUnchanged(dir, before);
    assert.equal(repo.currentRevision(), 1, "CURRENT 不切换");
    assert.ok(!fs.existsSync(path.join(dir, "generations", "000002")), "被否决的 Generation 不确认");
  });

  it("loadCurrent 遇 invariant 破损（事件 id 重复）→ 灾备回退上一代 + recoveredFrom + 告警", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    repo.commit(1, sampleSave("二"));
    // 单文件 codec 合法（EventSchema 通过），组合后跨文件不变量矛盾
    fs.writeFileSync(
      path.join(dir, "generations", "000002", "events.json"),
      JSON.stringify({
        events: [buildEvent({ id: "evt_1", seq: 1, content: "甲" }), buildEvent({ id: "evt_1", seq: 1, content: "乙" })],
      }),
    );

    let loaded: ReturnType<GenerationRepository["loadCurrent"]> | undefined;
    const warnings = captureWarn(() => {
      loaded = repo.loadCurrent();
    });
    assert.equal(loaded?.revision, 1, "回退到上一代");
    assert.equal(loaded?.recoveredFrom, 2, "标记坏掉的 revision");
    assert.equal(loaded?.save.world["note"], "一");
    assert.ok(warnings.some((line) => /存档灾备.*不变量破损.*回退上一代/.test(line)), "明确报告恢复行为");
  });

  it("loadPrevious 同样过整档校验（灾备路径口径一致）", () => {
    const dir = tempDir("airp-gen-");
    const repo = new GenerationRepository(dir);
    repo.commit(0, sampleSave("一"));
    repo.commit(1, sampleSave("二"));
    fs.writeFileSync(
      path.join(dir, "generations", "000001", "events.json"),
      JSON.stringify({ events: [buildEvent({ id: "", seq: 1 })] }),
    );
    expectKind(() => repo.loadPrevious(), "invariant");
  });
});
