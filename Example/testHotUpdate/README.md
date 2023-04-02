# react-native-android-detox

[![e2e-android](https://github.com/remarkablemark/react-native-android-detox/actions/workflows/e2e-android.yml/badge.svg)](https://github.com/remarkablemark/react-native-android-detox/actions/workflows/e2e-android.yml)

React Native Android Detox. The project has already been patched with the [additional Android configuration](https://wix.github.io/Detox/docs/introduction/project-setup/).

## Prerequisites

Follow the [environment setup](https://wix.github.io/Detox/docs/introduction/getting-started).

## Install

Clone the repository:

```sh
git clone https://github.com/remarkablemark/react-native-android-detox.git
cd react-native-android-detox
```

Install the dependencies:

```sh
yarn
```

## Build

### Android (Debug)

Build the Android debug app:

```sh
yarn detox build --configuration android.emu.debug
```

### Android (Release)

Build the Android release app:

```sh
yarn detox build --configuration android.emu.release
```

## Test

### Android (Debug)

Start the app:

```sh
yarn start
```

Run the test:

```sh
yarn detox test --configuration android.emu.debug
```

### Android (Release)

Run the test:

```sh
yarn detox test --configuration android.emu.release
```
