/* eslint-env mocha */
/* @flow */

const Promise = require('bluebird')
const fs = require('fs-extra')
const _ = require('lodash')
const path = require('path')
const should = require('should')

const metadata = require('../../core/metadata')

const dbBuilders = require('../support/builders/db')
const {
  scenarios,
  loadFSEventFiles,
  loadRemoteChangesFiles,
  runActions,
  init
} = require('../support/helpers/scenarios')
const configHelpers = require('../support/helpers/config')
const cozyHelpers = require('../support/helpers/cozy')
const { IntegrationTestHelpers } = require('../support/helpers/integration')
const pouchHelpers = require('../support/helpers/pouch')
const remoteCaptureHelpers = require('../../dev/capture/remote')

const { platform } = process

let helpers

// Spies
// FIXME: let prepCalls

describe('Test scenarios', function () {
  before(configHelpers.createConfig)
  before(configHelpers.registerClient)
  beforeEach(pouchHelpers.createDatabase)
  beforeEach(cozyHelpers.deleteAll)
  beforeEach('set up synced dir', async function () {
    await fs.emptyDir(this.syncPath)
  })
  beforeEach('set up outside dir', async function () {
    await fs.emptyDir(path.resolve(path.join(this.syncPath, '..', 'outside')))
  })

  afterEach(pouchHelpers.cleanDatabase)
  after(configHelpers.cleanConfig)

  beforeEach(async function () {
    helpers = new IntegrationTestHelpers(this.config, this.pouch, cozyHelpers.cozy)
    // FIXME: prepCalls = helpers.spyPrep()

    // TODO: helpers.setup()
    await helpers.local.setupTrash()
    await helpers.remote.ignorePreviousChanges()
  })

  afterEach(function () {
    // TODO: Include prep actions in custom assertion
    if (this.currentTest.state === 'failed') {
      // TODO: dump logs
    }
  })

  for (let scenario of scenarios) {
    if (scenario.platforms && !scenario.platforms.includes(platform)) {
      it.skip(`test/scenarios/${scenario.name}/  (skip on ${platform})`, () => {})
      continue
    }

    if (scenario.side === 'remote') {
      it.skip(`test/scenarios/${scenario.name}/local/  (skip remote only test)`, () => {})
    } else {
      for (let eventsFile of loadFSEventFiles(scenario)) {
        const localTestName = `test/scenarios/${scenario.name}/local/${eventsFile.name}`
        if (eventsFile.disabled) {
          it.skip(`${localTestName}  (${eventsFile.disabled})`, () => {})
          continue
        }

        let breakpoints = []
        if (eventsFile.events[0] && eventsFile.events[0].breakpoints) {
          breakpoints = eventsFile.events[0].breakpoints
          eventsFile.events = eventsFile.events.slice(1)
        } else {
          // break between each events
          for (let i = 0; i < eventsFile.events.length; i++) breakpoints.push(i)
        }

        if (process.env.NO_BREAKPOINTS) breakpoints = [0]

        for (let flushAfter of breakpoints) {
          it(localTestName + ' flushAfter=' + flushAfter, async function () {
            if (scenario.init) {
              let relpathFix = _.identity
              if (process.platform === 'win32' && localTestName.match(/win32/)) {
                relpathFix = (relpath) => relpath.replace(/\//g, '\\')
              }
              await init(scenario, this.pouch, helpers.local.syncDir.abspath, relpathFix)
            }

            const eventsBefore = eventsFile.events.slice(0, flushAfter)
            const eventsAfter = eventsFile.events.slice(flushAfter)

            await runActions(scenario, helpers.local.syncDir.abspath)
            await helpers.local.simulateEvents(eventsBefore)
            await helpers.syncAll()
            await helpers.local.simulateEvents(eventsAfter)
            await helpers.syncAll()
            await helpers.remote.pullChanges()
            await helpers.syncAll()

            await verifyExpectations(scenario, {includeRemoteTrash: true})

            // TODO: pull
          })
        } // event files
      }

      const stoppedTestName = `test/scenarios/${scenario.name}/local/stopped`
      const stoppedEnvVar = 'STOPPED_CLIENT'

      if (scenario.disabled) {
        it.skip(`${stoppedTestName} (${scenario.disabled})`, () => {})
      } else if (process.env[stoppedEnvVar] == null) {
        it.skip(`${stoppedTestName} (${stoppedEnvVar} is not set)`, () => {})
      } else {
        it(stoppedTestName, async function () {
          this.timeout(3 * 60 * 1000)
          // TODO: Find why we need this to prevent random failures and fix it.
          await Promise.delay(500)
          if (scenario.init) {
            let relpathFix = _.identity
            if (process.platform === 'win32' && this.currentTest.title.match(/win32/)) {
              relpathFix = (relpath) => relpath.replace(/\//g, '\\')
            }
            await init(scenario, this.pouch, helpers.local.syncDir.abspath, relpathFix, true)
          }

          await runActions(scenario, helpers.local.syncDir.abspath)

          await helpers.local.local.watcher.start()
          await helpers.local.local.watcher.stop(true)

          await helpers.syncAll()

          await verifyExpectations(scenario, {includeRemoteTrash: true})
        }) // test
      } // !eventsFile.disabled
    }

    const remoteTestName = `test/scenarios/${scenario.name}/remote/`
    if (scenario.name.indexOf('outside') !== -1) {
      it.skip(`${remoteTestName}  (skip outside case)`, () => {})
      continue
    }

    const captures = loadRemoteChangesFiles(scenario)
    for (let capture of captures) {
      const remoteCaptureTestName = `${remoteTestName}${capture.name}`

      if (scenario.disabled) {
        it.skip(`${remoteTestName}  (${scenario.disabled})`, () => {})
        continue
      } else if (scenario.side === 'local') {
        it.skip(`${remoteTestName}  (skip local only test)`, () => {})
        continue
      }

      it(remoteCaptureTestName, async function () {
        console.log({scenario, captures})

        if (scenario.init) {
          let relpathFix = _.identity
          if (process.platform === 'win32') {
            relpathFix = (relpath) => relpath.replace(/\//g, '\\')
          }
          await init(scenario, this.pouch, helpers.local.syncDir.abspath, relpathFix)
          await helpers.remote.ignorePreviousChanges()
        }

        await remoteCaptureHelpers.runActions(scenario, cozyHelpers.cozy)

        // FIXME: Extract function
        console.log({changes: capture.changes})
        for (let change of capture.changes) {
          const id = metadata.id((() => {
            // FIXME: Path normalization pure function
            // FIXME: Path should not be the remote one anyway (capture bug)
            const doc = {path: change._id.byPath}
            metadata.ensureValidPath(doc)
            return doc.path
          })())
          const old = change._id.byPath
            ? await this.pouch.byIdMaybeAsync(id)
            : null
          console.log({path: change._id.byPath, id, old})

          if (old) {
            const remoteInfos = {
              _id: old.remote._id,
              _rev: dbBuilders.rev(
                metadata.extractRevNumber(old) + change._rev.increment
              )
            }
            // FIXME: Do not mutate, map instead
            _.assign(change, remoteInfos)
            console.log({change})
          }
        }

        // TODO: Don't actually merge when scenario has only Prep assertions?
        await helpers.remote.simulateChanges(capture.changes)
        // TODO: Don't sync when scenario doesn't have target FS/trash assertions?
        for (let i = 0; i < scenario.actions.length + 1; i++) {
          await helpers.syncAll()
        }

        await verifyExpectations(scenario, {includeRemoteTrash: false})

        // TODO: Local trash assertions
      }) // describe remote
    }
  } // scenarios
})

async function verifyExpectations (scenario, {includeRemoteTrash}) {
  // TODO: Bring back Prep expectations for local tests?
  // TODO: Wrap in custom expectation
  if (scenario.expected) {
    const expectedLocalTree = scenario.expected.tree || scenario.expected.localTree
    const expectedRemoteTree = scenario.expected.tree || scenario.expected.remoteTree
    const expected = includeRemoteTrash ? _.pick(scenario.expected, ['remoteTrash']) : {}
    const actual = {}

    // TODO: expect prep actions
    if (expectedLocalTree) {
      expected.localTree = expectedLocalTree
      actual.localTree = await helpers.local.treeWithoutTrash()
    }
    if (expectedRemoteTree) {
      expected.remoteTree = expectedRemoteTree
      actual.remoteTree = await helpers.remote.treeWithoutTrash()
    }
    if (includeRemoteTrash && scenario.expected.remoteTrash) {
      actual.remoteTrash = await helpers.remote.trash()
    }
    if (scenario.expected.contents) {
      expected.localContents = scenario.expected.contents
      expected.remoteContents = scenario.expected.contents
      actual.localContents = {}
      actual.remoteContents = {}
      for (const relpath of _.keys(scenario.expected.contents)) {
        actual.localContents[relpath] = await helpers.local.readFile(relpath)
            .catch(err => `Error Reading Local(${relpath}): ${err.message}`)
        actual.remoteContents[relpath] = await helpers.remote.readFile(relpath)
            .catch(err => `Error Reading Remote(${relpath}): ${err.message}`)
      }
    }

    should(actual).deepEqual(expected)
  }
}
