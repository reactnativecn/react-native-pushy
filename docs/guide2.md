# 快速入门-添加热更新功能

## 获取appKey

检查更新时必须提供你的`appKey`，这个值保存在`update.json`中，并且根据平台不同而不同。你可以用如下的代码获取：

```javascript
import {
  Platform,
} from 'react-native';

import _updateConfig from './update.json';
const {appKey} = _updateConfig[Platform.OS];
```

如果你不使用pushy命令行，你也可以从网页端查看到两个应用appKey，并根据平台的不同来选择。

## 检查更新、下载更新

异步函数checkUpdate可以检查当前版本是否需要更新：

```javascript
checkUpdate(appKey)
    .then(info => {
    })
    
```

返回的info有三种情况：

1. `{expired: true}`：该应用包(原生部分)已过期，需要前往应用市场下载新的版本。

2. `{upToDate: true}`：当前已经更新到最新，无需进行更新。

3. `{update: true}`：当前有新版本可以更新。info的`name`、`description`字段可
以用于提示用户，而`metaInfo`字段则可以根据你的需求自定义其它属性(如是否静默更新、
是否强制更新等等)。另外还有几个字段，包含了完整更新包或补丁包的下载地址，
react-native-update会首先尝试耗费流量更少的更新方式。将info对象传递给downloadUpdate作为参数即可。

## 切换版本

downloadUpdate的返回值是一个hash字符串，它是当前版本的唯一标识。

你可以使用`switchVersion`函数立即切换版本(此时应用会立即重新加载)，或者选择调用
`switchVersionLater`，让应用在下一次启动的时候再加载新的版本。

## 首次启动、回滚

在每次更新完毕后的首次启动时，`isFirstTime`常量会为`true`。
你必须在应用退出前合适的任何时机，调用`markSuccess`，否则应用下一次启动的时候将会进行回滚操作。
这一机制称作“反触发”，这样当你应用启动初期即遭遇问题的时候，也能在下一次启动时恢复运作。

你可以通过`isFirstTime`来获知这是当前版本的首次启动，也可以通过`isRolledBack`来获知应用刚刚经历了一次回滚操作。
你可以在此时给予用户合理的提示。

## 完整的示例

```javascript
import React, {
  Component,
} from 'react';

import {
  AppRegistry,
  StyleSheet,
  Platform,
  Text,
  View,
  Alert,
  TouchableOpacity,
  Linking,
} from 'react-native';

import {
  isFirstTime,
  isRolledBack,
  packageVersion,
  currentVersion,
  checkUpdate,
  downloadUpdate,
  switchVersion,
  switchVersionLater,
  markSuccess,
} from 'react-native-update';

import _updateConfig from './update.json';
const {appKey} = _updateConfig[Platform.OS];

class MyProject extends Component {
  componentWillMount(){
    if (isFirstTime) {
      Alert.alert('提示', '这是当前版本第一次启动,是否要模拟启动失败?失败将回滚到上一版本', [
        {text: '是', onPress: ()=>{throw new Error('模拟启动失败,请重启应用')}},
        {text: '否', onPress: ()=>{markSuccess()}},
      ]);
    } else if (isRolledBack) {
      Alert.alert('提示', '刚刚更新失败了,版本被回滚.');
    }
  }
  doUpdate = info => {
    downloadUpdate(info).then(hash => {
      Alert.alert('提示', '下载完毕,是否重启应用?', [
        {text: '是', onPress: ()=>{switchVersion(hash);}},
        {text: '否',},
        {text: '下次启动时', onPress: ()=>{switchVersionLater(hash);}},
      ]);
    }).catch(err => { 
      Alert.alert('提示', '更新失败.');
    });
  };
  checkUpdate = () => {
    checkUpdate(appKey).then(info => {
      if (info.expired) {
        Alert.alert('提示', '您的应用版本已更新,请前往应用商店下载新的版本', [
          {text: '确定', onPress: ()=>{info.downloadUrl && Linking.openURL(info.downloadUrl)}},
        ]);
      } else if (info.upToDate) {
        Alert.alert('提示', '您的应用版本已是最新.');
      } else {
        Alert.alert('提示', '检查到新的版本'+info.name+',是否下载?\n'+ info.description, [
          {text: '是', onPress: ()=>{this.doUpdate(info)}},
          {text: '否',},
        ]);
      }
    }).catch(err => { 
      Alert.alert('提示', '更新失败.');
    });
  };
  render() {
    return (
      <View style={styles.container}>
        <Text style={styles.welcome}>
          欢迎使用热更新服务
        </Text>
        <Text style={styles.instructions}>
          这是版本一 {'\n'}
          当前包版本号: {packageVersion}{'\n'}
          当前版本Hash: {currentVersion||'(空)'}{'\n'}
        </Text>
        <TouchableOpacity onPress={this.checkUpdate}>
          <Text style={styles.instructions}>
            点击这里检查更新
          </Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F5FCFF',
  },
  welcome: {
    fontSize: 20,
    textAlign: 'center',
    margin: 10,
  },
  instructions: {
    textAlign: 'center',
    color: '#333333',
    marginBottom: 5,
  },
});

AppRegistry.registerComponent('MyProject', () => MyProject);
```

现在，你的应用已经可以通过update服务检查版本并进行更新了。下一步，你可以开始尝试发布应用包和版本，请参阅[发布应用](guide3.md)
