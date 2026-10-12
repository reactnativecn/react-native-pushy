# 全面审计（2026-09-02，基线 10.55.1 / b15223c）

> 范围：JS/TS 层、Android、iOS、共享 C++ 内核、鸿蒙、CI/发布/打包。严重级别 P1 真实缺陷 /
> P2 很可能的缺陷或明显风险 / P3 质量与性能 / P4 小项。代码注释按编号引用本文（如
> `CODE_AUDIT 2.12`），**编号保持不变**。
>
> **处理状态（2026-10-12 按当前代码复核）**：修复随 10.56.0 发布，master 提交为
> `a60809b3`（JS，§1/6.3/6.8）、`092f544a`（Android，§2）、`77b5488c`（iOS，§3）、
> `90f8d58e`（C++，§4）、`6a7f4163`（鸿蒙，§5）、`1e46ee06`（CI/发布，§6），评审跟进
> `5b0b9d29`。已修项每条压缩为一行；**仍开放 / 部分修复的项保留完整描述**，汇总如下：
>
> | 项 | 状态 |
> |---|---|
> | 1.10 | 部分：`require('../package.json')` 仍在 `src/core.ts`（收益小，有意保留） |
> | 2.6 | 部分：https-only + 安装后删除已做；APK sha256 校验未做 |
> | 2.13 / 单测建议 | 部分：两份 `UpdateModule.java`、`buildToolsVersion`；若干纯函数未覆盖 |
> | 3.10 | 部分：构建脚本仍写 pod 源码目录 |
> | 3.13 / 3.14 | 部分 / 未做：`RCTPushy.mm` 拆分、纯决策下沉 C++ + XCTest |
> | 4.4 | 部分：Android 已兜住；鸿蒙 NAPI 与 iOS 入口无 C++ catch |
> | 4.12 | 部分：`buildCheckFingerprint` 无 C++ 移植 |
> | §4 P4 | 开放：鸿蒙 NAPI 结果对象省略空串字段（Android 设 null） |
> | 5.7 | 部分：RCP 重定向控制（HMS-only）未做 |
> | 5.8 | 部分：`e2e_harmony` 不在门内 |
> | 5.15 / §5 P4 | 部分：若干纯函数未覆盖；`transferArchive` 未拆；`codelinter` 未接入 |
> | 6.4 | 未做（流程决策）：`.so` 仍提交在 `android/lib/` |
>
> 本文提到的 `librnupdate.so` 现名 `librnpushy.so`；`NativeCheckOrchestrator` 现名
> `SyncCoordinator`（b8bfe1fd）。原文第 7 节"建议的执行顺序"已全部执行，删去。

---

## 1. JS / TS 层（src/）

- **1.1（P2）** web 平台常量全是 Proxy 函数、每次加载上报假 rollback — 已修 a60809b3
- **1.2（P2）** `setOptions` 触发整套副作用重跑 — 已修 a60809b3（拆成三个 effect，启动检查只跑一次）
- **1.3（P2）** `setOptions({locale})` 被忽略 — 已修 a60809b3
- **1.4（P3）** `getRemoteEndpoints` 取第一个 settled 而非第一个成功 — 已修 a60809b3
- **1.5（P3）** 原生检查缓存复用绕过响应 schema 门 — 已修 a60809b3
- **1.6（P3）** 重试循环重复下载已确定性失败（`PATCH_FAILED`）的策略 — 已修 a60809b3
- **1.7（P3）** `applyingUpdate` 在 reload resolve 后永不复位 — 已修 a60809b3（跳过时打日志、reload 看门狗、reset 复位）
- **1.8（P3）** `Linking.openURL` 未 catch — 已修 a60809b3（`openExpiredDownload`）
- **1.9（P3）** 类型未导出、context 类型与实际不符 — 已修 a60809b3
- **1.11（P3）** release 下无条件 `console.log` — 已修 a60809b3（`__DEV__ || options.debug` 门控）
- **1.12（P3）** provider↔client 契约无测试 — 已修 a60809b3（`provider.contract.test.tsx` 用真实 client）
- **P4**（`lastRespJson` 去重槽、`downloadFallback` 失败码、死代码/死 locale key、非 2xx 文案截断、abort 监听与计时器泄漏、鸿蒙 appKey 检查、i18n、`{{name}}` 占位）— 全部已修 a60809b3

### 仍开放

**1.10（P3）依赖与包体**（部分修复）
已做：`react-native-url-polyfill` 换成 `parseQueryParams`，`nanoid` 换成内联 `createNonSecureId`，运行时依赖清零。
剩余：`src/core.ts` 的 `require('../package.json')` 把整个 manifest 打进 bundle；可在 prepublish 时生成 `version.ts`。收益小，§8 时有意保留。

---

## 2. Android 层（android/）

- **2.1** 状态持久化写入方无统一互斥 — 已修 092f544a（`UpdateContext.commitLock` 为所有 snapshot→commit 序列的唯一互斥）
- **2.2** `restartApp` 在 UI 线程做整包 SHA-256 + 同步 commit — 已修 092f544a（`prepareRestart` 走 `StateSerialRunner`，只有 reload 上 UI 线程）
- **2.3** 旧架构模块无 Promise、持久化失败静默 — 已修 092f544a
- **2.4** JNI 结果类无硬 keep、消费者规则过宽 — 已修 092f544a；10.56.0 发版前用 minify release 构建 + dexdump 核对，并修正 `reload` 返回类型匹配（583801ab）
- **2.5** cleanup keep 集合漏掉 `launchVersion` — 已修 092f544a（`CleanupKeepNames.select`，有 JVM 单测）
- **2.7** 检查响应体无大小上限 — 已修 092f544a（`SyncCoordinator.readBoundedBody`，1 MiB）
- **2.8** 冷启动关键路径冗余 IPC/commit — 已修 092f544a
- **2.9** 旧架构反射字段名无回退、失败时 recreate 加载旧 bundle — 已修 092f544a（`getCompatibleField`，失败 reject `RESTART_FAILED`）
- **2.10** 重下运行中 hash 会抹掉活目录 — 已修 092f544a（`ensureNotReinstallingRunningVersion`）
- **2.11** `options.getString` 缺 key 崩溃 — 已修 092f544a（`readRequiredString` → `INVALID_OPTIONS`）
- **2.12** 编排下载阶段超时不取消在途传输 — 已修 092f544a（`DownloadTaskParams.cancel` 取消 OkHttp Call，共享绝对 deadline）
- **P4**（无名 executor、`volatile`、`printStackTrace`、目录 fsync 等）— 已修 092f544a；`UpdatePackage` 仍继承 `TurboReactPackage`（替代 API 需 RN 0.74，peer 下限 0.59，已注明）

### 仍开放

**2.6（P2）APK 安装路径无内容校验**（部分修复）
已做：`downloadAndInstallApk` 拒绝非 https URL（`INVALID_OPTIONS`），`ApkInstaller.install` 在 session 拿到字节或失败后删除 APK。
剩余：安装前没有 sha256 校验（`ApkInstaller.java` 的 `TODO(CODE_AUDIT 2.6)`）。JS 传给 `downloadAndInstallApk` 的 `hash` 仍是进度键 `'downloadingApk'`，不是摘要；需要服务端下发 APK sha256 + JS/原生透传后才能校验。在此之前 https-only 是唯一的完整性边界。

**2.13（P3）重复与死代码**（部分修复）
已删：`clearFirstTime/isFirstTime`、`ReactNativeHostHandler`、`LOLLIPOP` 守卫、`build.gradle` 的陈旧路径/`repositories`/`versionName`，SDK 回退值更新到 34，`node` 只作最后手段。
剩余：两份 `UpdateModule.java`（oldarch/newarch，均已是薄转发层，只差基类与注解）；`buildToolsVersion` 仍设置。

**单测建议**（部分）
已有 `android/src/test` 5 个 JVM 测试类（CleanupKeepNames、HttpUtils、InstallRecord、SafeZipFile、UpdateFileUtils；CI 不跑，本地 `gradle testReleaseUnitTest`）。未覆盖：`ArchiveLimits.ensureFreeSpace`、`runCheckRequest` 次数上限、`BundledResourceCopier` 的路径/密度解析。

---

## 3. iOS 层（ios/）

- **3.1** 缺 PrivacyInfo.xcprivacy — 已修 77b5488c（`ios/PrivacyInfo.xcprivacy` 经 `s.resource_bundles` 发布）
- **3.2** `packageVersion/buildTime` 无前缀 defaults key — 已修 77b5488c（`REACTNATIVECN_PUSHY_*` + 旧 key 回退迁移；未改用 suite）
- **3.3** 归档 symlink 条目被物化 — 已修 77b5488c（unzip guard 拒绝 `S_IFLNK` 与 `.pushy-` 名，`preserveAttributes:NO`）
- **3.4** 畸形 `__diff.json` 抛 ObjC 异常 — 已修 77b5488c（`PushyPatchManifestFromJson` 全量 `isKindOfClass:` 校验，返回原因）；现由共享 C++ 解析器取代，见 3.14
- **3.5** 归档大小/剩余空间检查在落盘之后 — 已修 77b5488c（`didReceiveResponse` 前置检查 + `didReceiveData` 流式上限）
- **3.6** `use_frameworks!` 下 `buildTime` 资源找不到 — 已修 77b5488c（mainBundle → `bundleForClass:` → Info.plist mtime 回退）
- **3.7** 重载路径预消费首载状态、失败仍 resolve — 已修 77b5488c（去掉 `RCTReloadCommandSetBundleURL`，无可用 bridge 时 reject `RESTART_FAILED`）
- **3.8** 救援窗口里哈希内嵌 bundle — 已修 77b5488c（救援期只用缓存值，与 JS `getBundleHash` 单飞共享）
- **3.9** iOS 从不发出 `MARK_SUCCESS_FAILED/RESET_FAILED/RESTART_FAILED` — 已修 77b5488c
- **3.11** SSZipArchive 无版本约束 — 已修 77b5488c（`'~> 2.4'`）
- **3.12** `isUsingBundleUrl` 未导出 — 已修 77b5488c
- **P4**（锁断言、锁外哈希、`PushyHttpRequest` 重定向）— 已修 77b5488c

### 仍开放

**3.10（P3）构建时脚本写入 pod 源码目录**（部分修复）
已做：去掉 `USER_HEADER_SEARCH_PATHS` 里的绝对路径；script phase 声明了 output files。
剩余：脚本仍在 pod 源码目录可写时写 `ios/pushy_build_time.txt`（`:path` pod 每次构建弄脏 checkout，git 源 pod 改写 CocoaPods 缓存），而不是 `$(DERIVED_FILE_DIR)`；脚本内嵌 `podspec_dir` 作回退。

**3.13（P3，结构）`RCTPushy.mm` 拆分**（部分）
已做：重复实现已合并（`.resume` 后缀、文件大小、`runCheckRequest` 单一 `queryEndpoints`）；拆出 `RCTPushyOrchestrator.mm` 与共享的 `RCTPushyInternal.h`。
剩余：`RCTPushy.mm` 仍约 2150 行（目标约 900）；`PushyInstallRecord` / `PushyArchiveGuard` / `PushyDownloadRegistry` / `PushyState` / `PushyCrashRescue` 未拆。

**3.14（P3，可测试性）纯决策下沉 C++ + XCTest**（部分）
已做：`__diff.json` → `PatchManifest` 解析含类型校验下沉 `cpp/patch_core/patch_manifest.h`（`ParsePatchManifest`，向量 `cpp/patch_core/tests/patch-manifest-vectors.json` + fuzz），三端经 `archive_patch::ApplyArchivePatch` 直接传 manifest 原文，`PushyPatchManifestFromJson`、Java `appendManifestEntries`、Harmony `parseManifestToArrays` 已删。
剩余应下沉到 `cpp/` 的纯决策：安装记录校验 `install_record::Validate(json, hash)` 三端共用（目前 `install_record.h` 只有常量）；归档限额累加器；下载注册表 join/defer 规则与 `Content-Range` 解析（Java/ObjC 各一份）；crash-rescue 门控与检查端点尝试策略；`PushyIsSafePathComponent` 放到 `IsSafeRelativePath` 旁边。另建 `ios/Tests` XCTest target：`RCTPushyDownloader` 对 `NSURLProtocol` stub（416/206/redirect/encoded）、`unzipFileAtPath` 对夹具 zip（symlink、保留名、比值炸弹）。

---

## 4. 共享 C++ 内核（cpp/）

- **4.1（P1）** `IsSafeRelativePath` 不拒绝 NUL/控制字节（鸿蒙 staging 逃逸）— 已修 90f8d58e
- **4.2（P2）** 递归删目录/合并目录无深度上限 — 已修 90f8d58e（`kMaxDirectoryDepth`）
- **4.3（P2）** `patch_core` 测试不在 CI — 已修 1e46ee06（`test.yml` 跑 `SANITIZE=1 ./scripts/test-patch-core.sh`）
- **4.5（P3）** `flowjson::Parse` 无输入/节点上限 — 已修 90f8d58e（1 MiB / 65536 节点）
- **4.6（P3）** 数值解析/输出受 `LC_NUMERIC` 影响 — 已修 90f8d58e（手写十进制解析）
- **4.7（P3）** Murmur3 对非 ASCII key 与 TS 不一致 — 已修 90f8d58e（向量含非 ASCII）
- **4.8（P3）** 孤立代理项转义输出非法 UTF-8 — 已修 90f8d58e（归一到 U+FFFD）
- **4.9（P3）** HBC 变换路径整包读入内存两次 — 已修 90f8d58e（mmap 临时文件原地变换）
- **4.10（P3）** LZMA 字典大小无上限 — 已修 90f8d58e（`hpatch.c` `kMaxLzmaDictSize`）
- **4.11（P3）** payload 写入后 rename 前不 fsync — 已修 90f8d58e
- **4.13（P3）** 不可信输入解析器无 fuzz — 已修 90f8d58e（`fuzz_flow_json.cpp`、`fuzz_hbc_transform_wire.cpp`，CI `FUZZ=1`）
- **4.14（P3）** `ftell` 在 32 位 ABI 上截断 — 已修 90f8d58e（`fstat`）
- **P4** 测试脚本无 `-Werror` — 已修（`scripts/lib/cpp-test-common.sh` `CORE_WARNINGS`；vendored C 源仍只 `-Wall -Wextra`）

### 仍开放

**4.4（P2）STL 分配抛出的 C++ 异常穿越 JNI/NAPI/ObjC 边界**（部分修复）
Android 已兜住：`Application.mk` 改 `-fexceptions`，每个 JNI 入口经 `jni_util::GuardJni` / catch-all 转成 Java 异常或 null。
剩余：鸿蒙 `harmony/pushy/src/main/cpp/pushy.cpp` 的 NAPI 回调无 C++ `try/catch`，`bad_alloc/length_error` 会 unwind 进 NAPI；iOS `.mm` 只有 `@try/@catch(NSException*)`，抓不到 C++ 异常。4.5 的输入上限压低了可达性，但入口仍应 `catch (...)` 转成干净错误。另：`Application.mk` 仍带 `-fno-unwind-tables -fno-asynchronous-unwind-tables`，宜确认与 `-fexceptions` 同时使用时 unwind 正常。

**4.12（P3）对等性：`buildCheckFingerprint` 无 C++ 移植**（部分修复）
`IsMirrorRetryableCode` 已移植并进向量，`paths:null` 已有向量。`buildCheckFingerprint`（`src/updateFlowCore.ts`）仍只有 TS 实现，各原生编排器各自重实现了等价的去重逻辑——对等性框架抓不到这类漂移。

**P4 鸿蒙 NAPI 结果对象对空串字段直接省略**
`pushy.cpp` `SetStringProperty` 跳过空串，Android（`update_core_android.cpp` `SetStringField`）显式设 `null`；两端结果对象形状不一致。

---

## 5. 鸿蒙层（harmony/）

- **6e9ae76 声明核实**：single flush（激活校验已前移到第一个 `putSync` 之前）、归档限额（解压前检查原始大小与压缩比）、NAPI 严格响应校验、FOLLOWUPS 2026-08-13 方法表断裂与 `Logger isDebug` — 均已修 6a7f4163；鸿蒙 native-check e2e 仍开放，见 `docs/NATIVE_CHECK_FOLLOWUPS.md`
- **5.1（P1）** 只改 `cpp/`/`android/jni/` 时 publish 复用陈旧 HAR — 已修 1e46ee06（`publish.yml` 变更检测含 `cpp|android/jni|build-harmony-har.js|.gitmodules`）
- **5.2（P1）** 三个 async 方法注册为 SYNC — 已修 6a7f4163（`PUSHY_ASYNC_METHOD` + `scripts/check-native-spec-parity.js`）
- **5.3（P2）** `readTimeout` 语义是整次传输 — 已修 6a7f4163（绑定剩余 deadline）
- **5.4（P2）** `flushSync` 缺失时持久化 best-effort — 已修 6a7f4163（await `preferences.flush()`，失败拒绝）
- **5.5（P2）** 整包 SHA-256 在 UI 线程 — 已修 6a7f4163（只剩 `Sha256HexFileAsync`）
- **5.6（P2）** 鸿蒙几乎无稳定错误码 — 已修 6a7f4163（`ErrorCodes.ts` + `[CODE] msg` 前缀，JS `readErrorCode` 解析）
- **5.9（P3）** 归档限额在解压之后才生效 — 已修 6a7f4163（`zlib.getOriginalSize` 前置）
- **5.10（P3）** `cleanUp()` 绕过串行任务链 — 已修 6a7f4163
- **5.11（P3）** `forceBootRescue` 标记缺失 — 已修 6a7f4163
- **5.12（P3）** 无可观测性 — 已修 6a7f4163（里程碑 info/warn；DEBUG 取宿主 `isDebugModeEnabled`，HAR 内无法引用 `BuildProfile`）
- **5.13（P3）** HAR 版本标识陈旧 — 已修 6a7f4163（`build-harmony-har.js` 同步版本，`check-release-version.js` 断言）
- **5.14（P3）** `hvigor-plugin.ts` 每次调用改写消费者源码 — 已修 6a7f4163（只在 assemble 时由注册任务写，debug 输出 `0`）
- **P4**（EventHub、死代码、`removeDirectory`、`doPatchFrom*` 重复、`console.*`、`dataEnd` 未处理拒绝、`pushy.cpp` 小项、CMake 段/可见性、`.pushy-` 任意深度、INTERNET 权限文档）— 已修 6a7f4163

### 仍开放

**5.7（P2）https→http 降级**（部分修复）
已做：配置端点全为 https 时共享轮次内核（`cpp/update_flow_core/native_round.cpp`，三端共用）丢弃非 https 远程端点与 `http:` 产物 URL；`harmony/pushy/src/README.md` 要求消费者 `network_config.json` 设 `cleartextTrafficPermitted:false`。
剩余：`@ohos.net.http` 内部跟随重定向且不暴露最终 URL，https→http 的重定向降级仍可能发生；可接受 HMS-only 的话 RCP（`autoRedirect=false` + effective URL）能完全关闭。

**5.8（P2）鸿蒙 CI 门**（部分修复）
已做：`harmony-build.yml` 在固定容器里做类型检查（`HARMONY_TYPECHECK_REQUIRED=1` 时失败）与 release HAR 编译，并进 `native-gate`；hypium 套件已删除，鸿蒙纯逻辑测试改为 `src/__tests__/harmony*.test.ts` 在 bun 下跑（`test.yml`）。
剩余：`e2e_harmony.yml` 仅手动，不在门内（无托管鸿蒙 runner）。

**5.15（P3）测试**（部分修复）
已覆盖：ContentRange、InstallRecord、ErrorCodes、ArchiveLimits、NativeConfig、EventHub、原生轮次（请求体、端点查询、响应缓存：`native-round-vectors.json`）；C++ 头文件 ↔ ArkTS/Java/JS 镜像的常量对等由 `scripts/check-constant-parity.js`（`bun lint`）断言。
未覆盖：`readString/readBoolean`、flush-batch 深度语义。

**§5 P4 余项**
- `transferArchive`（`DownloadTask.ts`）仍约 470 行、大量闭包捕获的可变局部，未拆。
- ArkTS 禁止写法已大部分清除，仍有 `Record<string, any>`（`DownloadTask.ts`）；DevEco `codelinter` 未接入 CI。

---

## 6. CI / 发布 / 打包 / 仓库卫生

- **6.1（P2）** 测试覆盖缺口 — 已修 1e46ee06（patch_core + fuzz 进 `test.yml`、`harmony-build` 进门）；`e2e_harmony` 仍不在门内，见 5.8
- **6.2（P1）** publish 的 HAR 变更检测只看 `harmony/` — 已修，同 5.1
- **6.3（P3）** 根 package.json 死依赖/死脚本、firebase 残留、根 `e2e/` — 已修 a60809b3
- **6.5（P3）** README 无 options 索引 — 已修 1e46ee06（两份 README 的 Options reference）
- **6.6（P4）** 设计文档在仓库根、FOLLOWUPS 已关闭项与原文并存 — 已修（2026-10-12 移到 `docs/`；FOLLOWUPS 只留开放项）
- **6.7（P4）** 方法表对等性无自动化守护 — 已修 1e46ee06（`scripts/check-native-spec-parity.js`，`bun lint`）；iOS 已导出 `isUsingBundleUrl`
- **6.8（P3）** 远程端点列表不要求 https — 已修 a60809b3；可选的离线签名（内置公钥签 manifest）仍是长期建议

### 仍开放

**6.4（P3）仓库里的大二进制**（未做，流程决策）
`android/lib/*/librnpushy.so` 仍提交，每次重建都是 4 个新 blob；发布已由 `publish.yml` 在 CI 重建，可考虑不再提交 `.so`（本地开发走 `bun build:so`，或 git LFS）。`Example/harmony_use_pushy/debug.png`、`demo.png` 仍在仓库里。
