# 快速入门-发布应用

现在你的应用已经具备了检测更新的功能，下面我们来尝试发布并更新它。

## 发布iOS应用

首先参考[文档-在设备上运行](http://reactnative.cn/docs/0.22/running-on-device-ios.html#content)，
确定你正在使用离线包。然后点击菜单。

注意，从update上传发布版本到发布版本正式上线期间，不要修改任何脚本和资源，这会影响update
获取本地代码，从而导致版本不能更新。如果在发布之前修改了脚本或资源，请在网页端删除之前上传的版本并重新上传。

按照正常的发布流程打包`.ipa`文件(Product-Achieve)，然后运行如下命令

```bash
$ pushy uploadIpa <your-package.ipa>
```

