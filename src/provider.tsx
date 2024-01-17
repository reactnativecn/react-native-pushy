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
import { isFirstTime } from './core';
import { UpdateAvailableResult, CheckResult } from './type';
import { PushyContext } from './context';

export const PushyProvider = ({
  client,
  children,
}: {
  client: Pushy;
  children: ReactNode;
}) => {
  const { strategy, useAlert } = client.options;
  const stateListener = useRef<NativeEventSubscription>();
  const [updateInfo, setUpdateInfo] = useState<CheckResult>();
  const [lastError, setLastError] = useState<Error>();

  const dismissError = useCallback(() => {
    if (lastError) {
      setLastError(undefined);
    }
  }, [lastError]);

  const showAlert = useCallback(
    (...args: Parameters<typeof Alert.alert>) => {
      if (useAlert) {
        Alert.alert(...args);
      }
    },
    [useAlert],
  );

  const switchVersion = useCallback(() => {
    if (updateInfo && 'hash' in updateInfo) {
      client.switchVersion(updateInfo.hash);
    }
  }, [client, updateInfo]);

  const switchVersionLater = useCallback(() => {
    if (updateInfo && 'hash' in updateInfo) {
      client.switchVersionLater(updateInfo.hash);
    }
  }, [client, updateInfo]);

  const doUpdate = useCallback(
    async (info: UpdateAvailableResult) => {
      try {
        const hash = await client.downloadUpdate(info);
        if (!hash) {
          return;
        }
        setUpdateInfo(info);
        stateListener.current && stateListener.current.remove();
        showAlert('Download complete', 'Do you want to apply the update now?', [
          {
            text: 'Later',
            style: 'cancel',
            onPress: () => {
              client.switchVersionLater(hash);
            },
          },
          {
            text: 'Now',
            style: 'default',
            onPress: () => {
              client.switchVersion(hash);
            },
          },
        ]);
      } catch (err) {
        setLastError(err);
        showAlert('Failed to update', err.message);
      }
    },
    [client, showAlert],
  );

  const checkUpdate = useCallback(async () => {
    let info: CheckResult;
    try {
      info = await client.checkUpdate();
    } catch (err) {
      setLastError(err);
      showAlert('Failed to check update', err.message);
      return;
    }
    if ('expired' in info) {
      const { downloadUrl } = info;
      setUpdateInfo(info);
      showAlert(
        'Major update',
        'A full update is required to download and install to continue.',
        [
          {
            text: 'OK',
            onPress: () => {
              if (downloadUrl) {
                if (Platform.OS === 'android' && downloadUrl.endsWith('.apk')) {
                  client.downloadAndInstallApk(downloadUrl);
                } else {
                  Linking.openURL(downloadUrl);
                }
              }
            },
          },
        ],
      );
    } else if ('update' in info) {
      showAlert(
        `Version ${info.name} available`,
        `What's new\n
	  ${info.description}
	  `,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'OK',
            style: 'default',
            onPress: () => {
              doUpdate(info as UpdateAvailableResult);
            },
          },
        ],
      );
    }
  }, [client, doUpdate, showAlert]);

  const markSuccess = client.markSuccess;

  useEffect(() => {
    if (isFirstTime) {
      markSuccess();
    }
    if (strategy === 'both' || strategy === 'onAppResume') {
      stateListener.current = AppState.addEventListener(
        'change',
        (nextAppState) => {
          if (nextAppState === 'active') {
            checkUpdate();
          }
        },
      );
    }
    if (strategy === 'both' || strategy === 'onAppStart') {
      checkUpdate();
    }
    let dismissErrorTimer: ReturnType<typeof setTimeout>;
    const { dismissErrorAfter } = client.options;
    if (typeof dismissErrorAfter === 'number' && dismissErrorAfter > 0) {
      dismissErrorTimer = setTimeout(() => {
        dismissError();
      }, dismissErrorAfter);
    }
    return () => {
      stateListener.current && stateListener.current.remove();
      clearTimeout(dismissErrorTimer);
    };
  }, [checkUpdate, client.options, dismissError, markSuccess, strategy]);

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
      }}
    >
      {children}
    </PushyContext.Provider>
  );
};
