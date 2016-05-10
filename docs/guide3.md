# 快速入门-发布应用

现在你的应用已经具备了检测更新的功能，下面我们来尝试发布并更新它。

> **注意**，从update上传发布版本到发布版本正式上线期间，不要修改任何脚本和资源，这会影响update
获取本地代码，从而导致版本不能更新。如果在发布之前修改了脚本或资源，请在网页端删除之前上传的版本并重新上传。

## 发布iOS应用

首先参考[文档-在设备上运行](http://reactnative.cn/docs/running-on-device-ios.html#content)，
确定你正在使用离线包。然后点击菜单。

按照正常的发布流程打包`.ipa`文件(Xcode中运行设备选真机或Generic iOS Device，然后菜单中选择Product-Archive)，然后运行如下命令

```bash
$ pushy uploadIpa <your-package.ipa>
```

即可上传ipa以供后续版本比对之用。

随后你可以选择往AppStore发布这个版本，也可以先通过Test flight等方法进行测试。

## 发布安卓应用

首先参考[文档-生成已签名的APK](http://reactnative.cn/docs/signed-apk-android.html#content)设置签名，
然后在android文件夹下运行`./gradlew assembleRelease`，你就可以在`android/app/build/outputs/apk/app-release.apk`中找到你的应用包。

然后运行如下命令

```bash
$ pushy uploadApk android/app/build/outputs/apk/app-release.apk
```

即可上传apk以供后续版本比对之用。

随后你可以选择往应用市场发布这个版本，也可以先往设备上直接安装这个apk文件以进行测试。

## 发布新的热更新版本

你可以尝试修改一行代码(譬如将版本一修改为版本二)，然后生成新的热更新版本。

```bash
$ pushy bundle --platform <ios|android>
Bundling with React Native version:  0.22.2
<各种进度输出>
Bundled saved to: build/output/android.1459850548545.ppk
Would you like to publish it?(Y/N) 
```

如果想要立即发布，此时输入Y。当然，你也可以在将来使用`pushy publish --platform <ios|android> <ppkFile>`来发布版本。

```
  Uploading [========================================================] 100% 0.0s
Enter version name: <输入版本名字，如1.0.0-rc>
Enter description: <输入版本描述>
Enter meta info: {"ok":1}
Ok.
Would you like to bind packages to this version?(Y/N)
```

此时版本已经提交到update服务，但用户暂时看不到此更新，你需要先将特定的包版本绑定到此热更新版本上。

此时输入Y立即绑定，你也可以在将来使用`pushy update --platform <ios|android>`来使得对应包版本的用户更新。
除此以外，你还可以在网页端操作，简单的将对应的包版本拖到此版本下即可。

```
Offset 0
1) FvXnROJ1 1.0.1 (no package)
2) FiWYm9lB 1.0 [1.0]
Enter versionId or page Up/page Down/Begin(U/D/B) <输入序号,U/D翻页,B回到开始，序号就是上面列表中)前面的数字>

1) 1.0(normal) - 3 FiWYm9lB (未命名)

Total 1 packages.
Enter packageId: <输入包版本序号，序号就是上面列表中)前面的数字>
```

版本绑定完毕后，客户端就应当可以检查到更新并进行更新了。

恭喜你，至此为止，你已经完成了植入代码热更新的全部工作。接下来，你可以查阅[常见问题与高级指南](faq_advance.md)了解更多深入的知识，尤其是在实际项目中的运用技巧。
