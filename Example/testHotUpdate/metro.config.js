const path = require('path');

const extraNodeModules = {
  'react-native': path.resolve(__dirname, 'node_modules/react-native'),
};
const blacklistRegexes = [
  /react-native-update[\/\\]node_modules[\/\\]react-native[\/\\].*/,
];
const watchFolders = [path.resolve(__dirname, '../..')];

module.exports = {
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: false,
      },
    }),
  },
  resolver: {
    extraNodeModules,
    blacklistRE: require('metro-config/src/defaults/blacklist')(
      blacklistRegexes,
    ),
  },
  watchFolders,
};
