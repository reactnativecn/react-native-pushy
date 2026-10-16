import { describe, expect, test } from 'bun:test';
import { DownloadTaskParams } from '../../harmony/pushy/src/main/ets/DownloadTaskParams';

// The resume decisions DownloadTask.ts used to parse itself (Content-Range
// and the rest) live in the shared native core and are pinned by
// cpp/patch_core/tests/resume-plan-vectors.json.

describe('harmony DownloadTaskParams', () => {
  test('defaults to a full-package task with empty paths', () => {
    const params = new DownloadTaskParams();
    expect(params.type).toBe(DownloadTaskParams.TASK_TYPE_PATCH_FULL);
    expect(params.url).toBe('');
    expect(params.hash).toBe('');
    expect(params.originHash).toBe('');
    expect(params.targetFile).toBe('');
    expect(params.unzipDirectory).toBe('');
    expect(params.originDirectory).toBe('');
    expect(params.deadlineUptimeMs).toBe(0);
  });

  test('task types are distinct', () => {
    expect(
      new Set([
        DownloadTaskParams.TASK_TYPE_PATCH_FULL,
        DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP,
        DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK,
      ]).size
    ).toBe(3);
  });
});
