import {RNAbility} from 'rnoh/ts';

export default class EntryAbility extends RNAbility {
  getPagePath() {
    return 'pages/Index';
  }

  shouldCleanUpRNInstance__hack() {
    return true // Used by RNOH devs. If set to true, the app may crash.
  }
}
