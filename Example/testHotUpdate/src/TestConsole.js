/* eslint-disable react-native/no-inline-styles */
/* eslint-disable react/react-in-jsx-scope */
import {useCallback, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  Button,
  StyleSheet,
  SafeAreaView,
  Text,
  ScrollView,
  View,
  TouchableOpacity,
} from 'react-native';

import {PushyModule} from 'react-native-update';
const Hash = '9D5CE6EBA420717BE7E7D308B11F8207681B066C951D68F3994D19828F342474';
const UUID = '00000000-0000-0000-0000-000000000000';
const DownloadUrl =
  'http://cos.pgyer.com/697913e94d7441f20c686e2b0996a1aa.apk?sign=363b035b7ef52c199c268abfacee3712&t=1678603669&response-content-disposition=attachment%3Bfilename%3DtestHotupdate_1.0.apk';
export default function TestConsole({visible}) {
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [options, setOptions] = useState();
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
          onPress={() => {
            NativeTestMethod[i].invoke();
          }}
          style={{width: 10, height: 10, backgroundColor: 'red'}}
        />,
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
        <Button
          title="执行"
          testID="submit"
          onPress={async () => {
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
              Alert.alert('done');
            } catch (e) {
              Alert.alert(e.message);
            }
            setRunning(false);
          }}
        />
        <ScrollView style={{marginTop: 15}}>
          <Button title="重置" onPress={() => setText('')} />

          {renderTestView()}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
