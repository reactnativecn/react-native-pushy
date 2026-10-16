/**
 * 下载任务参数类
 */
export class DownloadTaskParams {
  // 任务类型常量
  // <generated:archive-patch-types> (scripts/contract.ts; bun scripts/generate-contract.ts)
  static readonly TASK_TYPE_PATCH_FULL: number = 1;
  static readonly TASK_TYPE_PATCH_FROM_APP: number = 2;
  static readonly TASK_TYPE_PATCH_FROM_PPK: number = 3;
  // </generated:archive-patch-types>

  type: number = DownloadTaskParams.TASK_TYPE_PATCH_FULL; // 任务类型
  url: string = ''; // 下载URL
  hash: string = ''; // 文件哈希值
  originHash: string = ''; // 原始文件哈希值
  targetFile: string = ''; // 目标文件路径
  unzipDirectory: string = ''; // 解压目录路径
  originDirectory: string = ''; // 原始文件目录路径
  // Native cold-start orchestrator's absolute monotonic-uptime deadline. Zero
  // uses the normal public download API's 10-minute whole-call cap.
  deadlineUptimeMs: number = 0;
}
