/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 */
'use strict';
import React, {
  AppRegistry,
  Component,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
} from 'react-native';

import {downloadFile, reloadUpdate} from 'react-native-update'

class testHotUpdate extends Component {
  render() {
    return (
      <View style={styles.container}>
        <Text style={styles.welcome}>
          Welcome to React Native!
        </Text>
        <Text style={styles.instructions}>
          To get started, edit index.ios.js
        </Text>
        <TouchableOpacity onPress={
          ()=>{
            downloadFile({updateUrl:'http://7xjhby.com2.z0.glb.qiniucdn.com/ios1.ppk', hashName:'test'})
          }
        }>
        <Text style={styles.instructions}>
          Press To DownloadFile
        </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={
          ()=>{
            reloadUpdate({hashName:'test'})
          }
        }>
          <Text style={styles.instructions}>
            Press To Reload
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

AppRegistry.registerComponent('testHotUpdate', () => testHotUpdate);
