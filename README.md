# react-native-update [![npm version](https://badge.fury.io/js/react-native-update.svg)](http://badge.fury.io/js/react-native-update)

本组件是面向 React Native 提供热更新功能的组件，详情请访问我们的官方网站 <https://pushy.reactnative.cn>。

### 快速开始

请查看[文档](https://pushy.reactnative.cn/docs/getting-started.html)

### 优势

1. 基于阿里云高速 CDN 分发，对比其他服务器在国外的热更新服务，分发更稳定，更新成功率极高。
2. 基于 bsdiff/hdiff 算法创建的**超小更新包**，通常版本迭代后在几十 KB 级别（其他全量热更新服务所需流量通常在几十 MB 级别）。
3. 始终跟进 RN 最新正式版本，第一时间提供支持。支持 hermes 字节码格式。（暂不支持新架构，会待其相对稳定后跟进）
4. 跨越多个版本进行更新时，只需要下载**一个更新包**，不需要逐版本依次更新。
5. 命令行工具 & 网页双端管理，版本发布过程简单便捷，完全可以集成 CI。
6. 支持崩溃回滚，安全可靠。
7. meta 信息及开放 API，提供更高扩展性。
8. 提供付费的专人技术支持。

### 本地开发

```
$ git clone git@github.com:reactnativecn/react-native-pushy.git
$ cd react-native-pushy/Example/testHotUpdate
$ yarn
$ yarn start
```

本地库文件使用 yarn link 链接，因此可直接在源文件中修改，在 testHotUpdate 项目中调试。

### 关于我们

本组件由[React Native 中文网](https://reactnative.cn/)独家发布，如有定制需求可以[联系我们](https://reactnative.cn/about.html#content)。

关于此插件发现任何问题，可以前往[Issues](https://github.com/reactnativecn/react-native-pushy/issues)发帖提问。

