import {by, device, element, expect} from 'detox';

describe('测试Native模块的方法', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  it('setLocalHashInfo', async () => {
    await element(by.id('testcase')).longPress();
    await element(by.id('setLocalHashInfo')).tap();
    await element(by.id('submit')).tap();
    await expect(element(by.text('done'))).toBeVisible();
    await element(by.text('OK')).tap();
  });

  it('getLocalHashInfo', async () => {
    await element(by.id('getLocalHashInfo')).tap();
    await element(by.id('submit')).tap();
    await expect(element(by.text('done'))).toBeVisible();
    await element(by.text('OK')).tap();
  });

  it('setUuid', async () => {
    await element(by.id('setUuid')).tap();
    await element(by.id('submit')).tap();
    await expect(element(by.text('done'))).toBeVisible();
    await element(by.text('OK')).tap();
  });

  it('setBlockUpdate', async () => {
    await element(by.id('setBlockUpdate')).tap();
    await element(by.id('submit')).tap();
    await expect(element(by.text('done'))).toBeVisible();
    await element(by.text('OK')).tap();
  });

  // it('reloadUpdate', async () => {
  //   await element(by.id('reloadUpdate')).tap();
  //   await element(by.id('submit')).tap();
  //   await expect(element(by.text('刚刚更新失败了,版本被回滚.'))).toBeVisible();
  //   await element(by.text('OK')).tap();
  // });

  it('setNeedUpdate', async () => {
    // await element(by.id('testcase')).longPress();
    await element(by.id('setNeedUpdate')).tap();
    await element(by.id('submit')).tap();
    await expect(element(by.text('done'))).toBeVisible();
    await element(by.text('OK')).tap();
  });

  it('markSuccess', async () => {
    await element(by.id('markSuccess')).tap();
    await element(by.id('submit')).tap();
    await expect(element(by.text('done'))).toBeVisible();
    await element(by.text('OK')).tap();
  });

  it('downloadPatchFromPpk', async () => {
    await element(by.id('downloadPatchFromPpk')).tap();
    await element(by.id('submit')).tap();
    await expect(element(by.text('failed to open zip file'))).toBeVisible();
    await element(by.text('OK')).tap();
  });

  it('downloadPatchFromPackage', async () => {
    await element(by.id('downloadPatchFromPackage')).tap();
    await element(by.id('submit')).tap();
    await expect(element(by.text('failed to open zip file'))).toBeVisible();
    await element(by.text('OK')).tap();
  });

  it('downloadFullUpdate', async () => {
    await element(by.id('downloadFullUpdate')).tap();
    await element(by.id('submit')).tap();
    await expect(element(by.text('failed to open zip file'))).toBeVisible();
    await element(by.text('OK')).tap();
  });

  if (device.getPlatform() === 'android') {
    it('downloadAndInstallApk', async () => {
      await element(by.id('testcase')).longPress();
      await element(by.id('downloadAndInstallApk')).tap();
      await element(by.id('submit')).tap();
      await expect(element(by.text('failed to open zip file'))).toBeVisible();
      await element(by.text('OK')).tap();
    });
  }
});
