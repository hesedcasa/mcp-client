import {disposeSharedConfigDir} from './helpers.js'

// Root-level hook, on purpose: mocha runs root `after` hooks once every suite
// has finished — including when an earlier suite failed — so the token-bearing
// shared config dir never outlives the run. It lives in its own file because a
// hook inside helpers.ts would make eslint-plugin-mocha treat that module as a
// test file and reject its exports.
// eslint-disable-next-line mocha/no-top-level-hooks
after(disposeSharedConfigDir)
