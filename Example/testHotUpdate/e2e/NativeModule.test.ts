import {by, device, element, expect, waitFor} from 'detox';
describe('测试Native模块的方法', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  it('setLocalHashInfo', async () => {
    await element(by.id('testcase')).longPress();
    await element(by.id('setLocalHashInfo')).longPress();
    await element(by.id('submit')).longPress();
    await expect(element(by.id('done'))).toBeVisible();
    await element(by.id('done')).longPress();
    await expect(element(by.id('done'))).toBeNotVisible();
  });

  it('getLocalHashInfo', async () => {
    await element(by.id('getLocalHashInfo')).longPress();
    await element(by.id('submit')).longPress();
    await expect(element(by.text('done'))).toBeVisible();
    await element(by.id('done')).longPress();
    await expect(element(by.id('done'))).toBeNotVisible();
  });

  it('setUuid', async () => {
    await element(by.id('setUuid')).longPress();
    await element(by.id('submit')).longPress();
    await expect(element(by.text('done'))).toBeVisible();
    await element(by.id('done')).longPress();
    await expect(element(by.id('done'))).toBeNotVisible();
  });
  
  if (device.getPlatform() === 'android') {
    it('reloadUpdate', async () => {
      await element(by.id('reloadUpdate')).longPress();
      await element(by.id('submit')).longPress();
      await waitFor(element(by.text('确认')))
        .toBeVisible()
        .withTimeout(10000);
      await element(by.id('done')).longPress();
      await expect(element(by.id('done'))).toBeNotVisible();
    });
  }

  it('setNeedUpdate', async () => {
    await element(by.id('setNeedUpdate')).longPress();
    await element(by.id('submit')).longPress();
    await expect(element(by.text('done'))).toBeVisible();
    await element(by.id('done')).longPress();
    await expect(element(by.id('done'))).toBeNotVisible();
  });

  if (device.getPlatform() === 'android') {
    it('markSuccess', async () => {
      await element(by.id('markSuccess')).longPress();
      await element(by.id('submit')).longPress();
      await waitFor(element(by.text('确认')))
        .toBeVisible()
        .withTimeout(10000);
      await element(by.id('done')).longPress();
    });
  }

  it('downloadPatchFromPpk', async () => {
    await element(by.id('downloadPatchFromPpk')).longPress();
    await element(by.id('submit')).longPress();
    if (device.getPlatform() === 'ios') {
      await expect(element(by.text('failed to open zip file'))).toBeVisible();
    } else {
      await waitFor(element(by.text('确认')))
        .toBeVisible()
        .withTimeout(10000);
    }
    await element(by.id('done')).longPress();
    await expect(element(by.id('done'))).toBeNotVisible();
  });

  it('downloadPatchFromPackage', async () => {
    await element(by.id('downloadPatchFromPackage')).longPress();
    await element(by.id('submit')).longPress();
    if (device.getPlatform() === 'ios') {
      await expect(element(by.text('failed to open zip file'))).toBeVisible();
    } else {
      await waitFor(element(by.text('确认')))
        .toBeVisible()
        .withTimeout(10000);
    }
    await element(by.id('done')).longPress();
    await expect(element(by.id('done'))).toBeNotVisible();
  });

  it('downloadFullUpdate', async () => {
    await element(by.id('downloadFullUpdate')).longPress();
    await element(by.id('submit')).longPress();
    if (device.getPlatform() === 'ios') {
      await expect(element(by.text('failed to open zip file'))).toBeVisible();
    } else {
      await waitFor(element(by.text('确认')))
        .toBeVisible()
        .withTimeout(10000);
    }
    await element(by.id('done')).longPress();
    await expect(element(by.id('done'))).toBeNotVisible();
  });

  if (device.getPlatform() === 'android') {
    it('downloadAndInstallApk', async () => {
      await element(by.id('downloadAndInstallApk')).longPress();
      await element(by.id('submit')).longPress();
      await waitFor(element(by.text('确认')))
        .toBeVisible()
        .withTimeout(10000);
      await element(by.id('done')).longPress();
      await expect(element(by.id('done'))).toBeNotVisible();
    });
  }
});
