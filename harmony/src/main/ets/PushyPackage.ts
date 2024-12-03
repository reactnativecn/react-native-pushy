import { RNPackage, TurboModulesFactory } from 'rnoh/ts';
import type { TurboModule, TurboModuleContext } from 'rnoh/ts';
import { PushyTurboModule } from './PushyTurboModule';

class PushyTurboModulesFactory extends TurboModulesFactory {
  createTurboModule(name: string): TurboModule | null {
    if (name === 'Pushy') {
      return new PushyTurboModule(this.ctx);
    }
    return null;
  }

  hasTurboModule(name: string): boolean {
    return name === 'Pushy';
  }
}

export class PushyPackage extends RNPackage {
  createTurboModulesFactory(ctx: TurboModuleContext): TurboModulesFactory {
    return new PushyTurboModulesFactory(ctx);
  }
}