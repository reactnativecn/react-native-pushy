# 原生冷启动检测:遗留改进项

> 设计见 `NATIVE_CHECKUPDATE_DESIGN.md`(§10 冷启动检测、§11 崩溃救援)。
> 本文只保留**仍开放**的项。四轮评审(2026-08-10/11)、2026-09-02 全面审计
> 后续与 2026-08-12/13 三端救砖实测的完整记录(40 条发现的逐条问题描述、
> 修法与实测时序)已收敛,见 git 历史:
> `git show 4ca8972e:docs/NATIVE_CHECK_FOLLOWUPS.md`。

## 已收敛结论(备查)

- 四轮评审 40 条发现:除下文开放项外全部修复或显式拍板(P3 `.pushy-complete`
  无迁移 → 接受一次性重下;P4 bundleHash 未就绪窗口指纹失配 → 接受并在
  `readNativeCheckCache` 注明;iOS owner-only 进度事件 → 不采纳)。
- 崩溃时刻救援(10.52.0,§11):Android 真机与 iOS Release 模拟器均实测
  "启动即崩"的砖一次崩溃即救回(Android 崩溃→commit 4.28s);鸿蒙 RNOH 未捕获
  JS 错误不杀进程,无需 crash hold,模拟器实测 forceBoot 端到端救回。
- 2026-08-13 鸿蒙功能性断裂:`PushyTurboModule.cpp` 方法表漏注册 10.50+ 的
  新方法,原生冷启动检测在鸿蒙自 10.51.0 起从未生效;已修(10.52.1),并由
  `scripts/check-native-spec-parity.js` 与 harmony-build CI 防回归。
- 已知覆盖边界(README 已写明):crash hold 只逮 JS exception 形态的崩溃,
  不覆盖原生崩溃 / ANR / OOM 击杀,以及 iOS 上安装了自定义
  `RCTSetFatalHandler` 的应用。

## 开放项

- [ ] **鸿蒙 e2e 缺 native-check 场景**:`e2e/harmony.jest.config.js` 的
      testMatch 只含 `e2e/harmony/**`(smoke + local-update),
      `e2e/native/native-check.test.ts` 只在 Android/iOS 跑。需把用例移植到
      hdc + uitest driver(模拟器 127.0.0.1 不通宿主,用 `hdc rport`)。
- [ ] **救砖(crash-on-launch)无自动化 e2e**:§11 的三端实测都是手工的
      (Detox 逮不住 JS 起不来的 app)。现有 native-check 用例只覆盖
      "服务端 forceBoot → 原生激活",不覆盖"坏 bundle 崩溃 → 救援 → 下次
      启动进修复版"。
- [ ] **鸿蒙真机救砖复测**:目前只有 DevEco 模拟器实证。
- [ ] (可选)iOS 主线程 crash hold 预算 3.5s 按 Android ANR 定,iOS watchdog
      上限约 20s,可放宽;主线程 RCTFatal 实际只有 bundle 加载失败一族
      (由 first_time 回滚接住),优先级低。
