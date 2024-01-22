import React, {useState} from 'react';
import {
  StyleSheet,
  Platform,
  Text,
  View,
  TouchableOpacity,
  Image,
  Switch,
} from 'react-native';
import {Icon, PaperProvider, Snackbar, Banner} from 'react-native-paper';

import TestConsole from './TestConsole';

import _updateConfig from '../update.json';
import {PushyProvider, Pushy, usePushy} from 'react-native-update';
const {appKey} = _updateConfig[Platform.OS];

function App() {
  const {
    client,
    checkUpdate,
    downloadUpdate,
    switchVersionLater,
    switchVersion,
    updateInfo,
    packageVersion,
    currentHash,
    progress: {received, total} = {},
  } = usePushy();
  const [useDefaultAlert, setUseDefaultAlert] = useState(true);
  const [showTestConsole, setShowTestConsole] = useState(false);
  const [showUpdateBanner, setShowUpdateBanner] = useState(false);
  const [showUpdateSnackbar, setShowUpdateSnackbar] = useState(false);
  const snackbarVisible =
    showUpdateSnackbar &&
    updateInfo &&
    updateInfo.updateAvailable &&
    !useDefaultAlert;
  return (
    <View style={styles.container}>
      <Text style={styles.welcome}>欢迎使用Pushy热更新服务</Text>
      <View style={{flexDirection: 'row'}}>
        <Text>
          {useDefaultAlert ? '当前使用' : '当前不使用'}默认的alert更新提示
        </Text>
        <Switch
          value={useDefaultAlert}
          onValueChange={v => {
            setUseDefaultAlert(v);
            client.setOptions({
              showAlert: v,
            });
          }}
        />
      </View>
      <Image
        resizeMode={'contain'}
        source={require('./assets/shezhi.png')}
        style={styles.image}
      />
      <Text style={styles.instructions}>
        这是版本一 {'\n'}
        当前原生包版本号: {packageVersion}
        {'\n'}
        当前热更新版本Hash: {currentHash || '(空)'}
        {'\n'}
      </Text>
      <Text>
        下载进度：{received} / {total}
      </Text>
      <TouchableOpacity onPress={checkUpdate}>
        <Text style={styles.instructions}>点击这里检查更新</Text>
      </TouchableOpacity>

      <TouchableOpacity
        testID="testcase"
        style={{marginTop: 15}}
        onLongPress={() => {
          setShowTestConsole(true);
        }}>
        <Text style={styles.instructions}>
          react-native-update版本：{client.version}
        </Text>
      </TouchableOpacity>
      <TestConsole visible={showTestConsole} />
      {snackbarVisible && (
        <Snackbar
          visible={true}
          onDismiss={() => {
            setShowUpdateSnackbar(false);
          }}
          action={{
            label: '更新',
            onPress: async () => {
              setShowUpdateSnackbar(false);
              await downloadUpdate();
              setShowUpdateBanner(true);
            },
          }}>
          <Text>有新版本({updateInfo.version})可用，是否更新？</Text>
        </Snackbar>
      )}
      <Banner
        visible={showUpdateBanner}
        actions={[
          {
            label: '立即重启',
            onPress: switchVersion,
          },
          {
            label: '下次再说',
            onPress: () => {
              switchVersionLater();
              setShowUpdateBanner(false);
            },
          },
        ]}
        icon={({size}) => (
          <Icon name="checkcircleo" size={size} color="#00f" />
        )}>
        更新已完成，是否立即重启？
      </Banner>
    </View>
  );
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

const pushyClient = new Pushy({
  appKey,
  showAlert: false,
});

export default function Root() {
  return (
    <PushyProvider client={pushyClient}>
      <PaperProvider>
        <App />
      </PaperProvider>
    </PushyProvider>
  );
}
