import React, {
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  NativeEventSubscription,
  AppState,
  Platform,
  Linking,
} from 'react-native';
import { Pushy } from './client';
import {
  currentVersion,
  isFirstTime,
  packageVersion,
  getCurrentVersionInfo,
} from './core';
import { CheckResult, ProgressData, PushyTestPayload } from './type';
import { PushyContext } from './context';
import { URL } from 'react-native-url-polyfill';

export const PushyProvider = ({
  client,
  children,
}: {
  client: Pushy;
  children: ReactNode;
}) => {
  const { options } = client;
  const stateListener = useRef<NativeEventSubscription>();
  const [updateInfo, setUpdateInfo] = useState<CheckResult>();
  const updateInfoRef = useRef(updateInfo);
  const [progress, setProgress] = useState<ProgressData>();
  const [lastError, setLastError] = useState<Error>();
  const lastChecking = useRef(0);

  const throwErrorIfEnabled = useCallback(
    (e: Error) => {
      if (options.throwError) {
        throw e;
      }
    },
    [options.throwError],
  );

  const dismissError = useCallback(() => {
    setLastError(undefined);
  }, []);

  const alertUpdate = useCallback(
    (...args: Parameters<typeof Alert.alert>) => {
      if (
        options.updateStrategy === 'alwaysAlert' ||
        options.updateStrategy === 'alertUpdateAndIgnoreError'
      ) {
        Alert.alert(...args);
      }
    },
    [options.updateStrategy],
  );

  const alertError = useCallback(
    (...args: Parameters<typeof Alert.alert>) => {
      if (options.updateStrategy === 'alwaysAlert') {
        Alert.alert(...args);
      }
    },
    [options.updateStrategy],
  );

  const switchVersion = useCallback(
    async (info: CheckResult | undefined = updateInfoRef.current) => {
      if (info && info.hash) {
        return client.switchVersion(info.hash);
      }
    },
    [client],
  );

  const switchVersionLater = useCallback(
    async (info: CheckResult | undefined = updateInfoRef.current) => {
      if (info && info.hash) {
        return client.switchVersionLater(info.hash);
      }
    },
    [client],
  );

  const downloadUpdate = useCallback(
    async (info: CheckResult | undefined = updateInfoRef.current) => {
      if (!info || !info.update) {
        return;
      }
      try {
        const hash = await client.downloadUpdate(info, setProgress);
        if (!hash) {
          return;
        }
        stateListener.current && stateListener.current.remove();
        if (options.updateStrategy === 'silentAndNow') {
          return client.switchVersion(hash);
        } else if (options.updateStrategy === 'silentAndLater') {
          return client.switchVersionLater(hash);
        }
        alertUpdate('提示', '下载完毕，是否立即更新?', [
          {
            text: '下次再说',
            style: 'cancel',
            onPress: () => {
              client.switchVersionLater(hash);
            },
          },
          {
            text: '立即更新',
            style: 'default',
            onPress: () => {
              client.switchVersion(hash);
            },
          },
        ]);
      } catch (e: any) {
        setLastError(e);
        alertError('更新失败', e.message);
        throwErrorIfEnabled(e);
      }
    },
    [
      client,
      options.updateStrategy,
      alertUpdate,
      alertError,
      throwErrorIfEnabled,
    ],
  );

  const downloadAndInstallApk = useCallback(
    async (downloadUrl: string) => {
      if (Platform.OS === 'android' && downloadUrl) {
        await client.downloadAndInstallApk(downloadUrl, setProgress);
      }
    },
    [client],
  );

  const checkUpdate = useCallback(
    async ({ extra }: { extra?: Record<string, any> } | undefined = {}) => {
      const now = Date.now();
      if (lastChecking.current && now - lastChecking.current < 1000) {
        return;
      }
      lastChecking.current = now;
      let info: CheckResult;
      try {
        info = await client.checkUpdate(extra);
      } catch (e: any) {
        setLastError(e);
        alertError('更新检查失败', e.message);
        throwErrorIfEnabled(e);
        return;
      }
      if (!info) {
        return;
      }
      updateInfoRef.current = info;
      setUpdateInfo(info);
      if (info.expired) {
        const { downloadUrl } = info;
        if (downloadUrl) {
          if (options.updateStrategy === 'silentAndNow') {
            if (Platform.OS === 'android' && downloadUrl.endsWith('.apk')) {
              downloadAndInstallApk(downloadUrl);
            } else {
              Linking.openURL(downloadUrl);
            }
            return;
          }
          alertUpdate('提示', '您的应用版本已更新，点击更新下载安装新版本', [
            {
              text: '更新',
              onPress: () => {
                if (Platform.OS === 'android' && downloadUrl.endsWith('.apk')) {
                  downloadAndInstallApk(downloadUrl);
                } else {
                  Linking.openURL(downloadUrl);
                }
              },
            },
          ]);
        }
      } else if (info.update) {
        if (
          options.updateStrategy === 'silentAndNow' ||
          options.updateStrategy === 'silentAndLater'
        ) {
          return downloadUpdate(info);
        }
        alertUpdate(
          '提示',
          '检查到新的版本' + info.name + ',是否下载?\n' + info.description,
          [
            { text: '取消', style: 'cancel' },
            {
              text: '确定',
              style: 'default',
              onPress: () => {
                downloadUpdate();
              },
            },
          ],
        );
      }
    },
    [
      client,
      alertError,
      throwErrorIfEnabled,
      options.updateStrategy,
      alertUpdate,
      downloadAndInstallApk,
      downloadUpdate,
    ],
  );

  const markSuccess = client.markSuccess;

  useEffect(() => {
    if (__DEV__ && !options.debug) {
      console.info(
        '您当前处于开发环境且未启用debug，不会进行热更检查。如需在开发环境中调试热更，请在client中设置debug为true',
      );
      return;
    }
    const { checkStrategy, dismissErrorAfter, autoMarkSuccess } = options;
    if (isFirstTime && autoMarkSuccess) {
      markSuccess();
    }
    if (checkStrategy === 'both' || checkStrategy === 'onAppResume') {
      stateListener.current = AppState.addEventListener(
        'change',
        nextAppState => {
          if (nextAppState === 'active') {
            checkUpdate();
          }
        },
      );
    }
    if (checkStrategy === 'both' || checkStrategy === 'onAppStart') {
      checkUpdate();
    }
    let dismissErrorTimer: ReturnType<typeof setTimeout>;
    if (typeof dismissErrorAfter === 'number' && dismissErrorAfter > 0) {
      dismissErrorTimer = setTimeout(() => {
        dismissError();
      }, dismissErrorAfter);
    }
    return () => {
      stateListener.current && stateListener.current.remove();
      clearTimeout(dismissErrorTimer);
    };
  }, [checkUpdate, options, dismissError, markSuccess]);

  const parseTestPayload = useCallback(
    (payload: PushyTestPayload) => {
      if (payload && payload.type && payload.type.startsWith('__rnPushy')) {
        const logger = options.logger || (() => {});
        options.logger = ({ type, data }) => {
          logger({ type, data });
          Alert.alert(type, JSON.stringify(data));
        };
        if (payload.type === '__rnPushyVersionHash') {
          checkUpdate({ extra: { toHash: payload.data } }).then(() => {
            if (updateInfoRef.current && updateInfoRef.current.upToDate) {
              Alert.alert(
                '提示',
                '当前尚未检测到更新版本，如果是首次扫码，请等待服务器端生成补丁包后再试（约10秒）',
              );
            }
            options.logger = logger;
          });
        }
        return true;
      }
      return false;
    },
    [checkUpdate, options],
  );

  const parseTestQrCode = useCallback(
    (code: string | PushyTestPayload) => {
      try {
        const payload = typeof code === 'string' ? JSON.parse(code) : code;
        return parseTestPayload(payload);
      } catch {
        return false;
      }
    },
    [parseTestPayload],
  );

  useEffect(() => {
    const parseLinking = (url: string | null) => {
      if (!url) {
        return;
      }
      const params = new URL(url).searchParams;
      const payload = {
        type: params.get('type'),
        data: params.get('data'),
      };
      parseTestPayload(payload);
    };

    Linking.getInitialURL().then(parseLinking);
    const linkingListener = Linking.addEventListener('url', ({ url }) =>
      parseLinking(url),
    );
    return () => {
      linkingListener.remove();
    };
  }, [parseTestPayload]);

  return (
    <PushyContext.Provider
      value={{
        checkUpdate,
        switchVersion,
        switchVersionLater,
        dismissError,
        updateInfo,
        lastError,
        markSuccess,
        client,
        downloadUpdate,
        packageVersion,
        currentHash: currentVersion,
        progress,
        downloadAndInstallApk,
        getCurrentVersionInfo,
        parseTestQrCode,
      }}>
      {children}
    </PushyContext.Provider>
  );
};
