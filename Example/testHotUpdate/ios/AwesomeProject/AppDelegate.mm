#import "AppDelegate.h"
#import "RCTPushy.h"

#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>
#import <React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import <React_RCTAppDelegate/RCTReactNativeFactory.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

// UIScene life cycle (required from the iOS 27 SDK on, RN 0.88 template):
// the window belongs to the scene, so React Native starts in SceneDelegate.
@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  return YES;
}

@end

@interface SceneDelegate : RCTDefaultReactNativeFactoryDelegate <UIWindowSceneDelegate>
@property (nonatomic, strong) UIWindow *window;
@property (nonatomic, strong) RCTReactNativeFactory *reactNativeFactory;
@end

@implementation SceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions
{
  if (![scene isKindOfClass:[UIWindowScene class]]) {
    return;
  }
  self.dependencyProvider = [RCTAppDependencyProvider new];
  self.reactNativeFactory = [[RCTReactNativeFactory alloc] initWithDelegate:self];
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  // A URL or universal link that launched the app comes with the scene; RN
  // 0.88 hands it to Linking.getInitialURL (which the provider's test channel
  // reads).
  [self.reactNativeFactory startReactNativeWithModuleName:@"AwesomeProject"
                                                 inWindow:self.window
                                        initialProperties:@{}
                                        connectionOptions:connectionOptions];
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts
{
  [RCTLinkingManager scene:scene openURLContexts:URLContexts];
}

- (void)scene:(UIScene *)scene continueUserActivity:(NSUserActivity *)userActivity
{
  [RCTLinkingManager scene:scene continueUserActivity:userActivity];
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
