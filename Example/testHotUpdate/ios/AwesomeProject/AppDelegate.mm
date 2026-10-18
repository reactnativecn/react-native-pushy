#import "AppDelegate.h"
#import "RCTPushy.h"

#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"AwesomeProject";
  self.dependencyProvider = [RCTAppDependencyProvider new];
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};
  // UIScene life cycle (required from the iOS 27 SDK on): the window belongs
  // to the scene, so React Native starts in SceneDelegate, not here.
  self.automaticallyLoadReactNativeWindow = NO;

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

- (NSURL *)bundleURL
{
  #if DEBUG
    // 原先DEBUG这里的写法不作修改(所以DEBUG模式下不可热更新)
    return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
  #else
    return [RCTPushy bundleURL];  // <--  把这里非DEBUG的情况替换为热更新bundle
  #endif
}

@end

// The scene owns the window: React Native starts here once it connects. A URL
// or universal link that launched the app arrives with the scene instead of
// in didFinishLaunching's launch options, so it is handed to React Native
// as a launch option (Linking.getInitialURL); later ones are forwarded to
// RCTLinkingManager (Linking 'url' events).
@interface SceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation SceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions
{
  if (![scene isKindOfClass:[UIWindowScene class]]) {
    return;
  }
  AppDelegate *app = (AppDelegate *)UIApplication.sharedApplication.delegate;
  NSMutableDictionary *launchOptions = [NSMutableDictionary dictionary];
  NSURL *url = connectionOptions.URLContexts.anyObject.URL;
  if (url != nil) {
    launchOptions[UIApplicationLaunchOptionsURLKey] = url;
  }
  NSUserActivity *activity = connectionOptions.userActivities.anyObject;
  if (activity != nil) {
    launchOptions[UIApplicationLaunchOptionsUserActivityDictionaryKey] = @{
      @"UIApplicationLaunchOptionsUserActivityKey" : activity,
      UIApplicationLaunchOptionsUserActivityTypeKey : activity.activityType,
    };
  }
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  app.window = self.window;
  [app.reactNativeFactory startReactNativeWithModuleName:app.moduleName
                                                inWindow:self.window
                                       initialProperties:app.initialProps
                                           launchOptions:launchOptions];
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts
{
  for (UIOpenURLContext *context in URLContexts) {
    [RCTLinkingManager application:UIApplication.sharedApplication openURL:context.URL options:@{}];
  }
}

- (void)scene:(UIScene *)scene continueUserActivity:(NSUserActivity *)userActivity
{
  [RCTLinkingManager application:UIApplication.sharedApplication
            continueUserActivity:userActivity
              restorationHandler:^(NSArray<id<UIUserActivityRestoring>> *_Nullable objects) {}];
}

@end
