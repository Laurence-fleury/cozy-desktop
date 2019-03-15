/* @flow */

const _ = require('lodash')

const { id } = require('../../metadata')
const Buffer = require('./buffer')
const logger = require('../../logger')

const STEP_NAME = 'winDetectMove'

const log = logger({
  component: `atom/${STEP_NAME}`
})

// Wait at most this delay (in milliseconds) to see if it's a move.
// TODO tweak the value (the initial value was chosen because it looks like a
//      good value, it is not something that was computed)
const DELAY = 1000

/*::
import type { AtomWatcherEvent } from './event'
import type Pouch from '../../pouch'

type PendingBatch = {
  events: AtomWatcherEvent[],
  deleted: Map<string, string>,
  timeout: TimeoutID
}
*/

module.exports = {
  loop
}

async function findDeleted (events, pouch) {
  const deleted = new Map()
  for (const event of events) {
    if (event.action === 'deleted') {
      const release = await pouch.lock('winMoveDetector')
      try {
        const was = await pouch.db.get(id(event.path))
        deleted.set(was.fileid, event.path)
      } catch (err) {
        _.set(event, [STEP_NAME, 'docNotFound'], err.message)
        if (err.status !== 404) log.error({err, event})
      } finally {
        release()
      }
    }
  }
  return deleted
}

function aggregateEvents (events, pending) {
  for (const event of events) {
    if (event.incomplete) {
      continue
    }
    if (event.action === 'created') {
      for (let i = 0; i < pending.length; i++) {
        const path = pending[i].deleted.get(event.stats.fileid)
        if (!path || path === event.path) {
          continue
        }
        const l = pending[i].events.length
        for (let j = 0; j < l; j++) {
          const e = pending[i].events[j]
          if (e.action === 'deleted' && e.path === path) {
            _.set(event, [STEP_NAME, 'aggregatedEvents'], {
              deletedEvent: e,
              createdEvent: _.clone(event)
            })
            event.action = 'renamed'
            event.oldPath = e.path
            pending[i].deleted.delete(event.stats.fileid)
            pending[i].events.splice(j, 1)
            break
          }
        }
      }
    }
  }
}

function sendReadyBatches (waiting /*: PendingBatch[] */, out /*: Buffer */) {
  while (waiting.length > 0) {
    if (waiting[0].deleted.size !== 0) {
      break
    }
    const item = waiting.shift()
    clearTimeout(item.timeout)
    out.push(item.events)
  }
}

// On windows, ReadDirectoryChangesW emits a deleted and an added events when
// a file or directory is moved. This step merges the two events to a single
// renamed event.
async function winDetectMove (buffer, out, pouch) {
  const pending /*: PendingBatch[] */ = []

  while (true) {
    // Wait for a new batch of events
    const events = await buffer.pop()

    // First, push the new events in the pending queue
    const deleted = await findDeleted(events, pouch)
    const timeout = setTimeout(() => {
      out.push(pending.shift().events)
      sendReadyBatches(pending, out)
    }, DELAY)
    pending.push({ events, deleted, timeout })

    // Then, see if a created event matches a deleted event
    aggregateEvents(events, pending)

    // Finally, look if some batches can be sent without waiting
    sendReadyBatches(pending, out)
  }
}

function loop (buffer /*: Buffer */, opts /*: { pouch: Pouch } */) /*: Buffer */ {
  const out = new Buffer()
  winDetectMove(buffer, out, opts.pouch)
    .catch(err => log.error({err}))
  return out
}
