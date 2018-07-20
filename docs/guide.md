# 快速入门-准备工作

首先你应该有一个基于React Native开发的应用，我们把具有package.json的目录叫做你的"应用根目录"。

如果你还没有初始化应用，请参阅[开始使用React Native](http://reactnative.cn/docs/getting-started.html#content)。

所以我们也假设你已经拥有了开发React Native应用的一切环境，包括`Node.js`、`npm`、`XCode`、`Android SDK`等等。

如果React Native的版本是0.45以下，并且你之前没安装过，你还必须安装[Android NDK](http://androiddevtools.cn)，版本最好选用r10e，并设置环境变量`ANDROID_NDK_HOME`，指向你的NDK根目录(例如`/Users/tdzl2003/Downloads/android-ndk-r10e`)。0.46以上的React Native不需要安装NDK。

## 安装

在你的项目根目录下运行以下命令：

```bash
npm i -g react-native-update-cli
npm i react-native-update@具体版本请看下面的表格
react-native link react-native-update
```  

`npm install -g react-native-update-cli`这一句在每一台电脑上仅需运行一次。  

* 注意 *

如果访问极慢或者显示网络失败，请设置使用淘宝镜像（也仅需设置一次）：  
```bash
npm install -g nrm
nrm use taobao
```

### 版本

因为React Native不同版本代码结构不同，因而请按下面表格对号入座：

| React Native版本 | react-native-update版本 |
| ---------------- | ----------------------- |
| 0.26及以下       | 1.0.x                   |
| 0.27 - 0.28      | 2.x                     |
| 0.29 - 0.33      | 3.x                     |
| 0.34 - 0.45      | 4.x                     |
| 0.46及以上       | 5.x                     |



安装命令示例：
```
npm i react-native-update@5.x
```

## 一、手动link

如果第一步的`react-native link`已成功(iOS工程和安卓工程均能看到依赖)，可以跳过此步骤

### iOS

1. 在XCode中的Project Navigator里,右键点击`Libraries` ➜ `Add Files to [你的工程名]`
2. 进入`node_modules` ➜ `react-native-update` ➜ `ios 并选中 `RCTHotUpdate.xcodeproj`
3. 在XCode中的project navigator里,选中你的工程,在 `Build Phases` ➜ `Link Binary With Libraries` 中添加 `libRCTHotUpdate.a`
4. 继续在`Build Settings`里搜索`Header Search Path`，添加$(SRCROOT)/../node_modules/react-native-update/ios
5. Run your project (`Cmd+R`)

### Android

1. 在`android/settings.gradle`中添加如下代码:
  	```
  	include ':react-native-update'
  	project(':react-native-update').projectDir = new File(rootProject.projectDir, 	'../node_modules/react-native-update/android')
  	```

2. 在`android/app/build.gradle`的 dependencies 部分增加如下代码:
  	```
      compile project(':react-native-update')
    ```

3. 检查你的RN版本,如果是0.29及以上, 打开`android/app/src/main/java/[...]/MainApplication.java`,否则打开`android/app/src/main/java/[...]/MainActivity.java`
  - 在文件开头增加 `import cn.reactnative.modules.update.UpdatePackage;`
  - 在`getPackages()` 方法中增加 `new UpdatePackage()`(注意上一行可能要增加一个逗号)

## 二、配置Bundle URL

### iOS

首先在工程target的Build Phases->Link Binary with Libraries中加入`libz.tbd`、`libbz2.1.0.tbd`


然后在你的AppDelegate.m文件中增加如下代码：

```objective-c
// ... 其它代码

#import "RCTHotUpdate.h"

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
#if DEBUG
  // 原来的jsCodeLocation保留在这里
  jsCodeLocation = ..........
#else
  // 非DEBUG情况下启用热更新
  jsCodeLocation=[RCTHotUpdate bundleURL];
#endif
  // ... 其它代码
}
```

### Android

`0.29及以后版本`：在你的MainApplication中增加如下代码：

```java
// ... 其它代码

// 请注意不要少了这句import
import cn.reactnative.modules.update.UpdateContext;
public class MainApplication extends Application implements ReactApplication {

  private final ReactNativeHost mReactNativeHost = new ReactNativeHost(this) {
    @Override
    protected String getJSBundleFile() {
        return UpdateContext.getBundleUrl(MainApplication.this);
    }
    // ... 其它代码
  }
}
```

`0.28及以前版本`：在你的MainActivity中增加如下代码：

```java
// ... 其它代码

// 请注意不要少了这句import
import cn.reactnative.modules.update.UpdateContext;

public class MainActivity extends ReactActivity {

    @Override
    protected String getJSBundleFile() {
        return UpdateContext.getBundleUrl(this);
    }
    // ... 其它代码
}
```

## 三、iOS的ATS例外配置
从iOS9开始，苹果要求以白名单的形式在Info.plist中列出外部的非https接口，以督促开发者部署https协议。在我们的服务部署https协议之前，请在Info.plist中添加如下例外（右键点击Info.plist，选择open as - source code）：
```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSExceptionDomains</key>
    <dict>
        <key>reactnative.cn</key>
        <dict>
            <key>NSIncludesSubdomains</key>
            <true/>
            <key>NSExceptionAllowsInsecureHTTPLoads</key>
            <true/>
        </dict>
   </dict>
</dict>
```


## 四、登录与创建应用

首先请在<http://update.reactnative.cn>注册帐号，然后在你的项目根目录下运行以下命令：

```bash
$ pushy login
email: <输入你的注册邮箱>
password: <输入你的密码>
```

这会在项目文件夹下创建一个`.update`文件，注意不要把这个文件上传到Git等CVS系统上。你可以在`.gitignore`末尾增加一行`.update`来忽略这个文件。

登录之后可以创建应用。注意iOS平台和安卓平台需要分别创建：

```bash
$ pushy createApp --platform ios
App Name: <输入应用名字>
$ pushy createApp --platform android
App Name: <输入应用名字>
```

> 两次输入的名字可以相同，这没有关系。

如果你已经在网页端或者其它地方创建过应用，也可以直接选择应用：

```bash
$ pushy selectApp --platform ios
1) 鱼多多(ios)
3) 招财旺(ios)

Total 2 ios apps
Enter appId: <输入应用前面的编号>
```

选择或者创建过应用后，你将可以在文件夹下看到`update.json`文件，其内容类似如下形式：

```bash
{
    "ios": {
        "appId": 1,
        "appKey": "<一串随机字符串>"
    },
    "android": {
        "appId": 2,
        "appKey": "<一串随机字符串>"
    }
}
```

你可以安全的把`update.json`上传到Git等CVS系统上，与你的团队共享这个文件，它不包含任何敏感信息。当然，他们在使用任何功能之前，都必须首先输入`pushy login`进行登录。

至此应用的创建/选择就已经成功了。下一步，你需要给代码添加相应的功能，请参阅[添加热更新功能](guide2.md)
