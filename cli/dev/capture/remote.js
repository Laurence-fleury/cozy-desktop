/* @flow */

import Promise from 'bluebird'
import fs from 'fs-extra'
import _ from 'lodash'
import path from 'path'

import * as metadata from '../../src/metadata'
import Pouch from '../../src/pouch'
import { FILES_DOCTYPE } from '../../src/remote/constants'
import RemoteCozy from '../../src/remote/cozy'

import configHelpers from '../../test/helpers/config'
import * as cozyHelpers from '../../test/helpers/cozy'

const debug = process.env.DEBUG != null ? console.log : (...args) => {}

const createInitialTree = async function (scenario: *, cozy: *, pouch: Pouch) {
  if (!scenario.init) return
  debug('init:')
  for (let doc of scenario.init) {
    let relpath = '/' + doc.path
    if (relpath.endsWith('/')) {
      relpath = _.trimEnd(relpath, '/') // XXX: Check in metadata.id?
      debug('- mkdir', relpath)
      const remoteDir = await cozy.files.createDirectoryByPath(relpath)
      await pouch.db.put({
        _id: metadata.id(relpath),
        docType: 'folder',
        updated_at: new Date(),
        path: relpath,
        ino: doc.ino,
        tags: [],
        sides: {local: 1, remote: 1},
        remote: {_id: remoteDir._id, _rev: remoteDir._rev}
      })
    } else {
    debug('- >', relpath)
      const parent = await cozy.files.statByPath(path.posix.dirname(relpath))
      let remoteFile = await cozy.files.create(Buffer.from(''), {
        dirID: parent._id,
        name: path.basename(relpath)
      })
      await pouch.db.put({
        _id: metadata.id(relpath),
        md5sum: '1B2M2Y8AsgTpgAmY7PhCfg==', // ''
        class: 'text',
        docType: 'file',
        executable: false,
        updated_at: new Date(),
        mime: 'text/plain',
        path: relpath,
        ino: doc.ino,
        size: 0,
        tags: [],
        sides: {local: 1, remote: 1},
        remote: {_id: remoteFile._id, _rev: remoteFile._rev}
      })
    }
  }
}

const runActions = (scenario: *, cozy: *) => {
  debug(`actions:`)
  return Promise.each(scenario.actions, async (action) => {
    switch (action.type) {
      case 'mkdir':
        debug('- mkdir', action.path)
        return cozy.files.createDirectoryByPath(`/${action.path}`)

      case '>':
        debug('- >', action.path)
        {
          const parentDir = await cozy.files.statByPath(
            `/${path.posix.dirname(action.path)}`)
          return cozy.files.create('whatever', {
            name: path.posix.basename(action.path),
            dirID: parentDir._id,
            contentType: 'text/plain'
          })
        }

      case '>>':
        debug('- >>', action.path)
        {
          const remoteFile = await cozy.files.statByPath(`/${action.path}`)
          return cozy.files.updateById(remoteFile._id, 'whatever blah', {
            contentType: 'text/plain'
          })
        }

      case 'rm':
        debug('- rm', action.path)
        {
          const remoteFile = await cozy.files.statByPath(`/${action.path}`)
          return cozy.files.trashById(remoteFile._id)
        }

      case 'mv':
        debug('- mv', action.src, action.dst)
        {
          const newParent = await cozy.files.statByPath(
            `/${path.posix.dirname(action.dst)}`)
          const remoteDoc = await cozy.files.statByPath(`/${action.src}`)
          return cozy.files.updateAttributesById(remoteDoc._id, {
            dir_id: newParent._id,
            // path: '/' + action.dst,
            name: path.posix.basename(action.dst)
          })
        }

      case 'wait':
        debug('- wait', action.ms)
        return Promise.delay(action.ms)

      default:
        return Promise.reject(new Error(
          `Unknown action ${action.type} for scenario ${scenario.name}`))
    }
  })
}

const setupConfig = () => {
  const context = {}
  configHelpers.createConfig.call(context)
  configHelpers.registerClient.call(context)
  const {config} = context
  return config
}

const setupPouch = async (config: *) => {
  const pouch = new Pouch(config)
  await pouch.addAllViewsAsync()
  return pouch
}

const captureScenario = async (scenario: *) => {
  // Setup
  const config = setupConfig()
  const pouch = await setupPouch(config)
  await cozyHelpers.deleteAll()
  await createInitialTree(scenario, cozyHelpers.cozy, pouch)
  const remoteCozy = new RemoteCozy(config)
  const {last_seq} = await remoteCozy.changes()

  // Run
  await runActions(scenario, cozyHelpers.cozy)

  // Capture
  const {docs} = await await remoteCozy.changes(last_seq)
  const json = JSON.stringify(docs, null, 2)
  const changesFile = scenario.path
    .replace(/scenario\.js/, path.join('remote', 'changes.json'))
  await fs.outputFile(changesFile, json)

  return path.basename(changesFile)
}

export default {
  name: 'remote',
  createInitialTree,
  runActions,
  captureScenario
}