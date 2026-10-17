# 持久化落盘布局（schema 1）与一次性迁移

> 适用版本：10.61.0 之后的下一个版本起。单一来源是 `scripts/contract.ts` 的
> `storeSchema` / `stateFields` / `storedItems` / `legacyLayouts`，
> `bun scripts/generate-contract.ts` 生成三端的 key 表、State ↔ 存储映射与
> C++ 旧布局表；迁移规则是共享内核 `cpp/patch_core/stored_items.h`，
> 向量 `cpp/patch_core/tests/stored-items-vectors.json`。

## 1. 统一后的布局

三端各有两个**自己的**键值存储，名字相同：

| 存储 | Android | iOS | 鸿蒙 | 内容 |
| --- | --- | --- | --- | --- |
| `pushy_state` | SharedPreferences 文件 | `NSUserDefaults` suite | preferences | 状态字段与其余各项、`schemaVersion` |
| `pushy_cache` | SharedPreferences 文件 | `NSUserDefaults` suite | preferences | 只有响应缓存 `nativeCheckResp` |

响应缓存单独放，是因为三端的存储每次落盘都会重写整个文件，整份服务端响应不该
跟着每一次小的状态提交一起重写（Android 早就这么做，这次三端对齐）。

**值的编码**：一律是字符串。布尔值存 `"1"` / `"0"`，缺失时取字段默认值
（`firstTime` 为 false，`firstTimeOk` 为 true）；标记（`firstLoadMarked`、
`binaryUpgraded`、`nativeCheckIncomplete`）置位时存 `"1"`，清除即删键；空串从不
落盘（写空串等于删键），所以“缺失”和“空”读起来一样。

**键**（三端同名）：

- 状态字段（`pushy::state::State`，由共享状态内核整体改写）：`packageVersion`、
  `buildTime`、`currentVersion`、`lastVersion`、`firstTime`、`firstTimeOk`、
  `rolledBackVersion`。
- `hash_<版本>`：版本元信息；`firstLoadMarked`；`binaryUpgraded`（仅 iOS 使用）；
  `nativeCheckResp`（缓存存储）；`nativeCheckIncomplete`；`uuid`；`nativeConfig`；
  `bundleHashCache`；`schemaVersion`（当前为 `"1"`）。

reset / 二进制升级各删什么仍由 `storedItems.clearedOn` 决定（与 #687 相同），
缓存存储在两种事件里都整体清掉。

## 2. 迁移只搬“升级后本来就保留”的东西

新布局只会随新的原生二进制上线（SDK 原生代码变了，必须重新打包）。而三端的
release 构建每次都会写入新的 buildTime：

- Android：`android/build.gradle` 的 `pushy_build_time` resValue，release 为构建时的分钟数；
- iOS：podspec 的 “Generate build time” 脚本阶段每次构建 `date +%s`（源码只读时退回
  安装包里的值，再不行用 Info.plist 的 mtime）；
- 鸿蒙：`hvigor-plugin.ts` 在 release 构建时写入当前时间。

所以新布局的第一次启动一定会被 `SyncBinaryVersion` 判为二进制升级：当前/上一
版本、首次加载标记、回滚标记清空，旧热更目录随后被清理。迁移因此只需要搬升级后
**保留**的项，外加判定升级用的二进制身份：

| 搬过去 | 为什么 |
| --- | --- |
| `uuid` | 标识安装，灰度分桶依据；变了会重洗分桶 |
| `nativeConfig` | 原生冷启动检测与 crash hold 在 JS 再次运行之前就要用 |
| `nativeCheckIncomplete` | 上次轮次中断时，本次启动不等 5 秒直接续传 |
| `bundleHashCache` | 以二进制身份为键，升级后自然失效，搬过去无害 |
| `packageVersion`、`buildTime` | 让升级照常由 `SyncBinaryVersion` 判定，而不是由迁移强行触发 |

热更状态（当前版本、版本元信息、首启/回滚标记、响应缓存）**不搬、直接删**。

**例外：debug 构建**三端的 buildTime 都固定为 `"0"`，同一台设备上换新 SDK 重新
debug 构建不会被判为升级；此时迁移后的状态里没有当前版本，启动内置包（热更版本
需要重新下载）。只影响开发期，且方向是安全的（回到内置包）。iOS 的
`legacy_migration_same_binary` 用例锁定这一行为。

## 3. 迁移规则（`MigrateStoredItems`）

输入：旧存储与新状态存储的快照（字符串键值；旧存储里的原生布尔读作 `"1"`/`"0"`，
数字读作文本，读不成文本的值——iOS 的旧 info 字典——读作 `""`：要删的键，绝不搬运）。
输出：`puts`（写入新状态存储，`schemaVersion` 永远最后一个）与 `removes`
（从旧存储删除，已排序）。

- 新存储 `schemaVersion` 为当前版本（1）：不写入；`removes` 为旧存储里仍然存在的、
  属于旧布局的键（上次迁移在删键前被杀，或降级期间旧二进制写回的键）。
- 新存储 `schemaVersion` 更大（未来的 SDK 写的，用户装回了本版本）：什么都不做，
  两个存储都不碰，按本版本认识的键读取。
- 否则（缺失或不是规范的正整数）：迁移。旧值非空、且新存储里还没有这个键时才写入
  （**新存储优先**：没有 schema 却已有值，要么是上次未完成迁移写进去的同一个值，
  要么是之后本 SDK 写的更新的值），最后写 `schemaVersion`。
- 只删旧布局**拥有**的键（`legacyLayouts` 列出的每个 SDK 写过的键与 `hash_` 前缀）。
  iOS 的旧存储是与宿主共用的 `standardUserDefaults`；Android/鸿蒙的旧文件名
  `update` 也很通用，宿主可能自己在用，所以同样只删认识的键。iOS 早期 SDK 写过的
  无前缀 `packageVersion`/`buildTime` 可能是宿主的，既不读也不删。

## 4. 宿主侧的 IO 与崩溃安全

三端都在**任何读取状态存储之前**执行迁移：Android 在 `UpdateContext` 构造函数里，
iOS 在 `PushyDefaults()` 的 `dispatch_once` 里，鸿蒙在 `UpdateContext` 构造函数里。

| 步骤 | Android | iOS | 鸿蒙 |
| --- | --- | --- | --- |
| 写 puts | 一次 `commit()`（整文件原子写） | 逐个 `setObject:`，schema 最后 | `putSync` 后一次 flush |
| 确认落盘 | `commit()` 返回 true | 写入在返回前已交给 cfprefsd，进程被杀不丢 | flush 成功 |
| 删 removes | 旧主文件与旧 `_check` 文件 | `standardUserDefaults` | 旧 preferences，再 flush |

- **幂等、可在任一步被杀后重入**：puts 落盘前被杀，旧键都还在，下次重做；iOS 在
  两个 put 之间被杀，已写的值按“新存储优先”保留、其余补写；puts 落盘后、删键前被杀，
  下次看到 schema 只删旧键。C++ 测试对每个向量的每一个前缀都验证了这一点。
- **落盘失败**：旧键保留，下次启动重试；本次进程内存里已有迁移结果，照常运行
  （Android 内存里的 schema 会随之后任意一次成功提交一并落盘，下次只剩删旧键）。
- **迁移本身失败**（内核抛异常、JNI/NAPI 不可用、计划无法解析）：按全新安装启动，
  但宿主单独把旧 `uuid` 搬过去；不写 schema，下次启动重做完整迁移。删旧键永远在
  写入之后，所以任何失败都不会丢掉 uuid（iOS 的 `remove-first` 负向对照验证）。

## 5. 降级（用户装回旧二进制）

- 旧二进制只认旧布局，而旧布局的键已被删除：它表现为**全新安装**——没有热更版本、
  没有原生配置（JS 运行后 `syncNativeConfig` 会重新写入），`uuid` 由 JS 重新生成，
  降级期间灰度分桶会变。它下载的热更目录与新二进制共用存储根目录，可能被它的清理删掉。
- 再升级回新二进制：新存储的 schema 还在，不再迁移；降级期间旧二进制写的键全部删除，
  `uuid` 恢复为降级前的值（分桶回到原样）。若重新安装的是同一个构建（身份相同），
  状态里的当前版本若目录已被旧二进制清掉，启动解析会回滚到内置包；否则照常判为升级。
- App Store / 应用市场不允许降级，降级只出现在侧载、`adb install -d`、企业分发等场景；
  为此保留旧 `uuid` 键会违背“迁移完成后删除旧 key”，权衡后不保留。

## 6. iOS 改用独立 suite 的取舍

改为 `initWithSuiteName:@"pushy_state"` / `@"pushy_cache"`，不再与宿主共用
`standardUserDefaults`：

- **避免键冲突**：无前缀的 `packageVersion`/`buildTime` 曾与宿主/三方 SDK 的键撞上，
  每次启动都像换了二进制、把已装热更清掉；独立命名空间后三端可以用同一组无前缀键名。
- **避免被宿主连带清空**：常见的“退出登录”实现是
  `removePersistentDomainForName:bundleIdentifier`，会把 uuid 与热更状态一起抹掉。
- **前缀扫描只扫自己的键**：reset / 升级删 `hash_*` 时不再遍历宿主的全部 defaults。
- 代价：多一个 plist 文件（同在 `Library/Preferences`，备份行为与之前相同）；
  隐私清单的 `CA92.1`（仅本应用读写）照样覆盖，不涉及 App Group。迁移需要处理旧键，
  即上面的一次性迁移。

## 7. 验证

- C++：`scripts/test-patch-core.sh` 的 `stored_items_test`（计划、应用后的两个存储、
  再次规划为空操作、任一前缀被杀后重入结果一致）。
- Android：`StoreMigrationTest`（JVM 单测，按向量回放迁移 IO、提交失败保留旧键、
  内核失败只搬 uuid、State 映射往返）。
- iOS：`scripts/test-ios-purge-restore.sh` 的 `stored_items_vectors`（真实内核 +
  真实 `PushyMigrateStores`）、`legacy_migration_upgrade` / `_same_binary` /
  `_write_failure` / `_read_failure`，负向对照 `skip-carry`、`remove-first`。
- 鸿蒙：`src/__tests__/harmonyStateLifecycle.test.ts`（按向量回放 `migrateStore`、
  落盘失败、内核失败、State 映射往返）。
