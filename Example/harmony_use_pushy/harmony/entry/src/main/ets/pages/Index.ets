import { ComponentBuilderContext, RNOHLogger } from 'rnoh';
import {
  RNApp,
  RNAbility,
  AnyJSBundleProvider,
  MetroJSBundleProvider,
  ResourceJSBundleProvider,
  TraceJSBundleProviderDecorator,
} from 'rnoh'
import { createRNPackages } from '../RNPackagesFactory'
@Builder
export function CustomComponentBuilder(ctx: ComponentBuilderContext) {

}

@Entry
@Component
struct Index {
  @StorageLink('RNAbility') private rnAbility: RNAbility | undefined = undefined
  @State shouldShow: boolean = false
  @State message: string = 'Hello World';

  aboutToAppear(): void {
    this.shouldShow = true
  }

  onBackPress(): boolean | undefined {
    // NOTE: this is required since `Ability`'s `onBackPressed` function always
    // terminates or puts the app in the background, but we want Ark to ignore it completely
    // when handled by RN
    return this.rnAbility?.onBackPress();
  }

  build() {
    Column() {
      if (this.rnAbility && this.shouldShow) {
        RNApp({
          rnInstanceConfig: { createRNPackages },
          initialProps: { "foo": "bar" } as Record<string, string>,
          appKey: "harmony_use_pushy",
          buildCustomComponent: CustomComponentBuilder,
          onSetUp: (rnInstance) => {
            rnInstance.enableFeatureFlag("ENABLE_RN_INSTANCE_CLEAN_UP")
          },
          jsBundleProvider: new TraceJSBundleProviderDecorator(
            new AnyJSBundleProvider([
              // MetroJSBundleProvider.fromServerIp('127.0.0.1'),
              // new ResourceJSBundleProvider(this.rnAbility.context.resourceManager, 'hermes_bundle.hbc'),
              new ResourceJSBundleProvider(this.rnAbility.context.resourceManager, 'bundle.harmony.js')
            ]),
            this.rnAbility.getLogger()),
        })
      }
    }
    .height('100%')
    .width('100%')
  }
}
