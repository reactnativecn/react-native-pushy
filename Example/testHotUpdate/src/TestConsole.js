/* eslint-disable react-native/no-inline-styles */
/* eslint-disable react/react-in-jsx-scope */
import {useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  Button,
  StyleSheet,
  SafeAreaView,
  Text,
  View,
} from 'react-native';

import {PushyModule} from 'react-native-update';

export default function TestConsole({visible}) {
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
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
          onPress={async () => {
            setRunning(true);
            try {
              const inputs = text.split('\n');
              const methodName = inputs[0];
              let params;
              if (inputs.length === 1) {
                await PushyModule[methodName]();
              } else {
                if (inputs.length === 2) {
                  params = inputs[1];
                } else {
                  params = {};
                  for (let i = 1; i < inputs.length; i += 2) {
                    params[inputs[i]] = inputs[i + 1];
                  }
                  console.log({inputs, params});
                }
                await PushyModule[methodName](params);
              }
              Alert.alert('done');
            } catch (e) {
              Alert.alert(e.message);
            }
            setRunning(false);
          }}
        />
        <View style={{marginTop: 15}}>
          <Button title="重置" onPress={() => setText('')} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}
