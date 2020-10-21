import React, {Component} from 'react';
import {
  StyleSheet,
  Platform,
  Text,
  View,
  Alert,
  TouchableOpacity,
  Linking,
  Image,
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
  downloadAndInstallApk,
} from 'react-native-update';

import _updateConfig from '../update.json';
const {appKey} = _updateConfig[Platform.OS];

export default class App extends Component {
  state = {
    received: 0,
    total: 0,
  };
  componentDidMount() {
    if (isRolledBack) {
      Alert.alert('提示', '刚刚更新失败了,版本被回滚.');
    } else if (isFirstTime) {
      Alert.alert(
        '提示',
        '这是当前版本第一次启动,是否要模拟启动失败?将回滚到上一版本',
        [
          {
            text: '是',
            onPress: () => {
              throw new Error('模拟启动失败,请重启应用');
            },
          },
          {
            text: '否',
            onPress: () => {
              markSuccess();
            },
          },
        ],
      );
    }
  }
  doUpdate = async (info) => {
    try {
      const hash = await downloadUpdate(info, {
        onDownloadProgress: ({received, total}) => {
          this.setState({
            received,
            total,
          });
        },
      });
      Alert.alert('提示', '下载完毕,是否重启应用?', [
        {
          text: '是',
          onPress: () => {
            switchVersion(hash);
          },
        },
        {text: '否'},
        {
          text: '下次启动时',
          onPress: () => {
            switchVersionLater(hash);
          },
        },
      ]);
    } catch (err) {
      Alert.alert('更新失败', err.message);
    }
  };

  checkUpdate = async () => {
    let info;
    try {
      info = await checkUpdate(appKey);
    } catch (err) {
      Alert.alert('更新检查失败', err.message);
      return;
    }
    if (info.expired) {
      Alert.alert('提示', '您的应用版本已更新，点击确定下载安装新版本', [
        {
          text: '确定',
          onPress: () => {
            if (info.downloadUrl) {
              // apk可直接下载安装
              if (
                Platform.OS === 'android' &&
                info.downloadUrl.endsWith('.apk')
              ) {
                downloadAndInstallApk({
                  url: info.downloadUrl,
                  onDownloadProgress: ({received, total}) => {
                    this.setState({
                      received,
                      total,
                    });
                  },
                });
              } else {
                Linking.openURL(info.downloadUrl);
              }
            }
          },
        },
      ]);
    } else if (info.upToDate) {
      Alert.alert('提示', '您的应用版本已是最新.');
    } else {
      Alert.alert(
        '提示',
        '检查到新的版本' + info.name + ',是否下载?\n' + info.description,
        [
          {
            text: '是',
            onPress: () => {
              this.doUpdate(info);
            },
          },
          {text: '否'},
        ],
      );
    }
  };

  render() {
    const { received, total } = this.state;
    return (
      <View style={styles.container}>
        <Text style={styles.welcome}>欢迎使用热更新服务</Text>
        <Image
          resizeMode={'contain'}
          source={require('./assets/shezhi.png')}
          style={styles.image}
        />
        <Text style={styles.instructions}>
          这是版本一 {'\n'}
          当前原生包版本号: {packageVersion}
          {'\n'}
          当前热更新版本Hash: {currentVersion || '(空)'}
          {'\n'}
        </Text>
        <Text>
          下载进度：{received} / {total}
        </Text>
        <TouchableOpacity onPress={this.checkUpdate}>
          <Text style={styles.instructions}>点击这里检查更新</Text>
        </TouchableOpacity>
        {/* <WebView style={{flex:1}} source={{uri: require('../www/index.html')}}/> */}
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
  image: {},
});
