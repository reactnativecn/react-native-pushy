import type {RNPackageContext, RNPackage} from 'rnoh/ts';
import {PushyPackage} from 'pushy/ts';

export function createRNPackages(ctx: RNPackageContext): RNPackage[] {
  return [new PushyPackage(ctx)];
}
