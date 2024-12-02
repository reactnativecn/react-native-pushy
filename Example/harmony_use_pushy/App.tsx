/* eslint-disable react/no-unstable-nested-components */
/* eslint-disable react-native/no-inline-styles */
import React, {useState} from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Image,
  Switch,
  Modal,
} from 'react-native';

import TestConsole from './TestConsole';

import _updateConfig from './update.json';
import {PushyProvider, Pushy, usePushy} from 'react-native-update';
const {appKey} = _updateConfig.harmony;

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
    parseTestQrCode,
    progress: {received, total} = {},
  } = usePushy();
  const [useDefaultAlert, setUseDefaultAlert] = useState(true);
  const [showTestConsole, setShowTestConsole] = useState(false);
  const [showUpdateBanner, setShowUpdateBanner] = useState(false);
  const [showUpdateSnackbar, setShowUpdateSnackbar] = useState(false);
  const snackbarVisible =
    !useDefaultAlert && showUpdateSnackbar && updateInfo?.update;

  console.log('😁Pushy', Pushy);

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
            client?.setOptions({
              updateStrategy: v ? null : 'alwaysAlert',
            });
            setShowUpdateSnackbar(!v);
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
      <TouchableOpacity
        onPress={() => {
          checkUpdate();
          setShowUpdateSnackbar(true);
        }}>
        <Text style={styles.instructions}>点击这里检查更新</Text>
      </TouchableOpacity>

      <TouchableOpacity
        testID="testcase"
        style={{marginTop: 15}}
        onLongPress={() => {
          setShowTestConsole(true);
        }}>
        <Text style={styles.instructions}>
          react-native-update版本：{client?.version}
        </Text>
      </TouchableOpacity>
      <TestConsole visible={showTestConsole} />
      {snackbarVisible && (
        <Modal
          animationType="slide"
          transparent={true}
          visible={snackbarVisible}
          onRequestClose={() => {
            setShowUpdateSnackbar(false);
          }}>
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              width: '100%',
              backgroundColor: '#333',
              padding: 16,
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
            <Text style={{color: 'white'}}>
              有新版本({updateInfo.name})可用，是否更新？
            </Text>
            <View style={{flexDirection: 'row'}}>
              <TouchableOpacity
                onPress={() => setShowUpdateSnackbar(false)}
                style={{marginRight: 10}}>
                <Text style={{color: 'white'}}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  setShowUpdateSnackbar(false);
                  await downloadUpdate();
                  setShowUpdateBanner(true);
                }}>
                <Text style={{color: '#2196F3'}}>更新</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
      <Modal
        animationType="slide"
        transparent={true}
        visible={showUpdateBanner}
        onRequestClose={() => setShowUpdateBanner(false)}>
        <View
          style={{
            position: 'absolute',
            top: 0,
            width: '100%',
            backgroundColor: '#fff',
            padding: 16,
            borderBottomWidth: 1,
            borderBottomColor: '#eee',
          }}>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <Text>更新已完成，是否立即重启？</Text>
          </View>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              marginTop: 10,
            }}>
            <TouchableOpacity
              onPress={() => {
                switchVersionLater();
                setShowUpdateBanner(false);
              }}
              style={{marginRight: 20}}>
              <Text style={{color: '#2196F3'}}>下次再说</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={switchVersion}>
              <Text style={{color: '#2196F3'}}>立即重启</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  debug: true,
});

console.log('😁pushyClient', Pushy);
export default function Root() {
  return <App />;
  // return (
  //   <PushyProvider client={pushyClient}>
  //     <App />
  //   </PushyProvider>
  // );
}
