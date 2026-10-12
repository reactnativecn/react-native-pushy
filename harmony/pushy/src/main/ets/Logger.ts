import hilog from '@ohos.hilog';

type HilogFunction = (
  domain: number,
  tag: string,
  format: string,
  ...args: string[]
) => void;

class Logger {
  private domain: number;
  private prefix: string;
  private format: string = '%{public}s,%{public}s';
  private isDebug: boolean;

  constructor(
    prefix: string = 'MyApp',
    domain: number = 0xff00,
    isDebug = false,
  ) {
    this.prefix = prefix;
    this.domain = domain;
    this.isDebug = isDebug;
  }

  // debug 级别默认关闭;宿主处于 RN 调试模式(RNOH isDebugModeEnabled)时由
  // TurboModule 在启动时打开,方便接入调试。info/warn/error 永远输出。
  // (HAR 自身没有可靠的构建期 DEBUG 信号:hvigor 只为宿主模块生成
  // BuildProfile,在 HAR 里 import 'BuildProfile' 无法解析。)
  setDebug(enabled: boolean): void {
    this.isDebug = enabled;
  }

  // args[0] is the tag, the rest is joined into the message.
  private log(fn: HilogFunction, args: string[]): void {
    fn(
      this.domain,
      this.prefix,
      this.format,
      args.length > 0 ? args[0] : '',
      args.length > 1 ? args.slice(1).join(' ') : '',
    );
  }

  debug(...args: string[]): void {
    if (this.isDebug) {
      this.log(hilog.debug, args);
    }
  }

  info(...args: string[]): void {
    this.log(hilog.info, args);
  }

  warn(...args: string[]): void {
    this.log(hilog.warn, args);
  }

  error(...args: string[]): void {
    this.log(hilog.error, args);
  }
}

export default new Logger('pushy', 0xff00, false);
