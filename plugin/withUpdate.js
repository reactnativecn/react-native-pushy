const { withDangerousMod } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');
const fs = require('fs');
const path = require('path');

const withUpdate = (config) => {
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectName = config.modRequest.projectName;
      const appDelegatePath = path.join(config.modRequest.platformProjectRoot, projectName, 'AppDelegate.mm');
      const contents = fs.readFileSync(appDelegatePath, 'utf-8');

      const newContents = mergeContents({
        src: contents,
        newSrc: '#import "RCTPushy.h"',
        anchor: '#import <React/RCTBundleURLProvider.h>',
        offset: 1,
        tag: 'react-native-update-header',
        comment: '//',
      });

      const finalContents = newContents.contents.replace(
        'return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];',
        'return [RCTPushy bundleURL];'
      );

      fs.writeFileSync(appDelegatePath, finalContents);

      return config;
    },
  ]);

  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const mainApplicationPath = path.join(config.modRequest.platformProjectRoot, 'app/src/main/java', ...config.android.package.split('.'), 'MainApplication.kt');
      const contents = fs.readFileSync(mainApplicationPath, 'utf-8');

      // 添加 import
      const contentsWithImport = mergeContents({
        src: contents,
        newSrc: 'import cn.reactnative.modules.update.UpdateContext',
        anchor: 'package',
        offset: 1,
        tag: 'react-native-update-import',
        comment: '//',
      });

      const bundleMethodCode = 'override fun getJSBundleFile(): String? = UpdateContext.getBundleUrl(this@MainApplication)';
      const finalContents = contentsWithImport.contents.replace(
        /override fun getJSMainModuleName\(\): String = "\.expo\/\.virtual-metro-entry"/,
        `$&\n\n          ${bundleMethodCode}`
      );

      fs.writeFileSync(mainApplicationPath, finalContents);

      return config;
    },
  ]);

  return config;
};

module.exports = withUpdate;