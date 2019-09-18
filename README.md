# react-native-update [![npm version](https://badge.fury.io/js/react-native-update.svg)](http://badge.fury.io/js/react-native-update)

本组件是面向 React Native 提供热更新功能的组件，建议结合[Update 服务](https://update.reactnative.cn/)使用。

### 最近更新

请查阅[最近更新文档](CHANGELOG.md)。

### 优势

1. 命令行工具&网页双端管理，版本发布过程简单便捷，完全可以集成 CI。
2. 基于 bsdiff 算法创建的**超小更新包**，通常版本迭代后在 1-10KB 之间，避免数百 KB 的流量消耗。
3. 支持崩溃回滚，安全可靠。
4. meta 信息及开放 API，提供更高扩展性。
5. 跨越多个版本进行更新时，只需要下载**一个更新包**，不需要逐版本依次更新。

### 安装与快速入门

请查阅

- [文档-快速入门-准备工作](docs/guide.md)。

- [文档-快速入门-添加热更新功能](docs/guide2.md)。

- [文档-快速入门-发布版本](docs/guide3.md)。

- [文档-常见问题与高级指南](docs/faq_advance.md)。

### 命令行工具

请查阅[文档-命令行工具](docs/cli.md)。

### API 接口

请查阅[文档-API 接口](docs/api.md)。

### 关于我们

本组件由[React Native 中文网](https://reactnative.cn/)独家发布，如有定制需求可以[联系我们](https://reactnative.cn/about.html#content)。

关于此插件发现任何问题，可以前往[Issues](https://github.com/reactnativecn/react-native-pushy/issues)或者[中文社区](http://bbs.reactnative.cn/category/7)发帖提问。
