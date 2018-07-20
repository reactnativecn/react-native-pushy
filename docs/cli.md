# 命令行工具

## 安装

```
$ npm install -g react-native-update-cli
$ npm install --save react-native-update
```

## 使用

#### pushy bundle

生成资源包

* platform: ios|android 对应的平台
* entryFile: 入口脚本文件
* intermediaDir: 临时文件输出目录
* output: 最终ppk文件输出路径
* dev: 是否打包开发版本
* verbose: 是否展现打包过程的详细信息

#### pushy diff <origin> <next>

提供两个ppk文件，生成从origin到next版本的差异更新包。

* output: diff文件输出路径

#### pushy diffFromApk <apkFile> <next>

提供一个apk文件和一个ppk文件，生成从apk文件到next版本的差异更新包。

如果使用热更新开放平台，你不需要自己执行此命令。

* output: diff文件输出路径

#### pushy diffFromIpa <ipaFile> <next>

提供一个ipa文件和一个ppk文件，生成从ipa文件到next版本的差异更新包。

如果使用热更新开放平台，你不需要自己执行此命令。

* output: diff文件输出路径

#### pushy login [<email>] [<pwd>]

登录热更新开放平台。你需要先登录才能使用下面的命令。

#### pushy logout

登出并清除本地的登录信息

#### pushy me

查看自己是否已经登录，以及昵称等信息。

#### pushy createApp

创建应用并立刻绑定到当前工程。这项操作也可以在网页管理端进行。

- platform: ios|android 对应的平台
- name: 应用名称
- downloadUrl: 应用安装包的下载地址

#### pushy deleteApp [appId]

删除已有应用。所有已创建的应用包、热更新版本都会被同时删除。这项操作也可以在网页管理端进行。

- platform: ios|android 对应的平台

#### pushy apps

查看当前已创建的全部应用。这项操作也可以在网页管理端进行。

- platform: ios|android 对应的平台

#### pushy selectApp [appId]

绑定应用到当前工程。

- platform: ios|android 对应的平台

#### pushy uploadIpa <ipaFile>

上传 ipa 文件到开放平台。

#### pushy uploadApk <apkFile>

上传 apk 文件到开放平台。

#### pushy packages

查看已经上传的包。这项操作也可以在网页管理端进行。

- platform: ios|android 对应的平台

#### pushy publish <ppkFile>

发布新的更新版本。

- platform: ios|android 对应的平台
- name: 当前版本的名字(版本号)
- description: 当前版本的描述信息，可以对用户进行展示
- metaInfo: 当前版本的元信息，可以用来保存一些额外信息

#### pushy versions

分页列举可用的版本。这项操作也可以在网页管理端进行。

- platform: ios|android 对应的平台

#### pushy update

为一个包版本绑定一个更新版本。这项操作也可以在网页管理端进行。

- platform: ios|android 对应的平台
- versionId: 要绑定的版本 ID
- packageId: 要绑定的包 ID
