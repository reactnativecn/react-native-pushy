export function logger(...args: any[]) {
  console.log('Pushy: ', ...args);
}

export function assertRelease() {
  if (__DEV__) {
    throw new Error('react-native-update 只能在 RELEASE 版本中运行.');
  }
}
