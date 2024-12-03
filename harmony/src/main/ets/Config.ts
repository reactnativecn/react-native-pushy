
export type Config = {
  skipPermissionRequests: boolean;
  authorizationLevel?: string;
  enableBackgroundLocationUpdates?: string;
}

export type ReqLocOptions = {
  timeout?: number;
  maximumAge?: number;
  enableHighAccuracy?: boolean;
}

export type GeolocationConfiguration = {
  skipPermissionRequests: boolean;
  authorizationLevel?: 'always' | 'whenInUse' | 'auto';
  locationProvider?: 'playServices' | 'android' | 'auto';
  enableBackgroundLocationUpdates?: boolean;
}

export type GeolocationOptions = {
  timeout?: number;
  maximumAge?: number;
  enableHighAccuracy?: boolean;
  distanceFilter?: number;
  useSignificantChanges?: boolean;
  interval?: number;
  fastestInterval?: number;
}