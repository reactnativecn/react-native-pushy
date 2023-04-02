/* eslint-disable react-native/no-inline-styles */
/* eslint-disable react/react-in-jsx-scope */
import {useCallback, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Modal,
  TextInput,
  Button,
  StyleSheet,
  SafeAreaView,
  Text,
  View,
  TouchableOpacity,
} from 'react-native';

import {PushyModule} from 'react-native-update';
const Hash = '9D5CE6EBA420717BE7E7D308B11F8207681B066C951D68F3994D19828F342474';
const UUID = '00000000-0000-0000-0000-000000000000';
const DownloadUrl =
  'http://cos.pgyer.com/697913e94d7441f20c686e2b0996a1aa.apk?sign=7a8f11b1df82cba45c8ac30b1acec88c&t=1680404102&response-content-disposition=attachment%3Bfilename%3DtestHotupdate_1.0.apk';


  const CustomDialog = ({title, visible, onConfirm}) => {
    if (!visible) {
      return null;
    }
  
    return (
      <View style={styles.overlay}>
        <View style={styles.dialog}>
          <Text style={styles.title}>{title}</Text>
          <TouchableOpacity testID='done' style={styles.button} onLongPress={onConfirm}>
            <Text style={styles.buttonText}>确认</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };
export default function TestConsole({visible}) {
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [options, setOptions] = useState();
  const [alertVisible, setAlertVisible] = useState(false);
  const [alertMsg, setAlertMsg] = useState('');
  const NativeTestMethod = useMemo(() => {
    return [
      {
        name: 'setLocalHashInfo',
        invoke: () => {
          setText(
            `setLocalHashInfo\n${Hash}\n{\"version\":\"1.0.0\",\"size\":\"19M\"}`,
          );
        },
      },
      {
        name: 'getLocalHashInfo',
        invoke: () => {
          setText(`getLocalHashInfo\n${Hash}`);
        },
      },
      {
        name: 'setUuid',
        invoke: () => {
          setText(`setUuid\n${UUID}`);
        },
      },
      {
        name: 'setBlockUpdate',
        invoke: () => {
          setText('setBlockUpdate');
          setOptions({reason: 'application has been block', until: 1673082950});
        },
      },
      {
        name: 'reloadUpdate',
        invoke: () => {
          setText('reloadUpdate');
          setOptions({hash: Hash});
        },
      },
      {
        name: 'setNeedUpdate',
        invoke: () => {
          setText('setNeedUpdate');
          setOptions({hash: Hash});
        },
      },
      {
        name: 'markSuccess',
        invoke: () => {
          setText('markSuccess');
          setOptions(undefined);
        },
      },
      {
        name: 'downloadPatchFromPpk',
        invoke: () => {
          setText('downloadPatchFromPpk');
          setOptions({updateUrl: DownloadUrl, hash: Hash, originHash: Hash});
        },
      },
      {
        name: 'downloadPatchFromPackage',
        invoke: () => {
          setText('downloadPatchFromPackage');
          setOptions({updateUrl: DownloadUrl, hash: Hash});
        },
      },
      {
        name: 'downloadFullUpdate',
        invoke: () => {
          setText('downloadFullUpdate');
          setOptions({updateUrl: DownloadUrl, hash: Hash});
        },
      },
      {
        name: 'downloadAndInstallApk',
        invoke: () => {
          setText('downloadAndInstallApk');
          setOptions({url: DownloadUrl, target: Hash, hash: Hash});
        },
      },
    ];
  }, []);

  const renderTestView = useCallback(() => {
    const views = [];
    for (let i = 0; i < NativeTestMethod.length; i++) {
      views.push(
        <TouchableOpacity
          key={i}
          testID={NativeTestMethod[i].name}
          onLongPress={() => {
            NativeTestMethod[i].invoke();
          }}
        >
        <Text>{NativeTestMethod[i].name}</Text>
        </TouchableOpacity>,
      );
    }
    return <View>{views}</View>;
  }, [NativeTestMethod]);

  return (
    <Modal visible={visible}>
      <SafeAreaView style={{flex: 1, padding: 10}}>
        <Text>调试Pushy方法（方法名，参数，值换行）</Text>
        <TextInput
          autoCorrect={false}
          autoCapitalize="none"
          style={{
            borderWidth: StyleSheet.hairlineWidth * 4,
            borderColor: 'black',
            height: '30%',
            marginTop: 20,
            marginBottom: 20,
            padding: 10,
            fontSize: 20,
          }}
          textAlignVertical="top"
          multiline={true}
          value={text}
          onChangeText={setText}
        />
        {running && <ActivityIndicator />}
        <TouchableOpacity
        style={{backgroundColor:'rgb(0,140,237)', justifyContent: 'center',
        alignItems: 'center',paddingTop:10,paddingBottom:10,marginBottom:5}}
          testID="submit"
          onLongPress={async () => {
            setRunning(true);
            try {
              const inputs = text.split('\n');
              const methodName = inputs[0];
              let params = [];
              if (inputs.length === 1) {
                if (options) {
                  await PushyModule[methodName](options);
                } else {
                  await PushyModule[methodName]();
                }
              } else {
                if (inputs.length === 2) {
                  params = [inputs[1]];
                } else {
                  params = [inputs[1], inputs[2]];
                  console.log({inputs, params});
                }
                await PushyModule[methodName](...params);
              }
              setAlertVisible(true);
              setAlertMsg('done');
            } catch (e) {
              setAlertVisible(true);
              setAlertMsg(e.message);
            }
            setRunning(false);
          }}
        >
          <Text style={{color:'white'}}>执行</Text>
        </TouchableOpacity>
         <Button title="重置" onPress={() => setText('')} />
          {renderTestView()}
          <CustomDialog
            title={alertMsg}
            visible={alertVisible}
            onConfirm={()=>{setAlertVisible(false)}}
      />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dialog: {
    backgroundColor: 'white',
    borderRadius: 10,
    padding: 20,
    width: '80%',
    alignItems: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#2196F3',
    borderRadius: 5,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  buttonText: {
    color: 'white',
    fontWeight: 'bold',
  },
});
