const noop = () => {};
export class Pushy {
  constructor() {
    console.warn(
      'react-native-update is not supported and will do nothing on web.',
    );
    return new Proxy(this, {
      get() {
        return noop;
      },
    });
  }
}
