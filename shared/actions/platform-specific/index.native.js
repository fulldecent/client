// @flow
import logger from '../../logger'
import {type TypedState} from '../../constants/reducer'
import * as RPCTypes from '../../constants/types/rpc-gen'
import * as ConfigGen from '../config-gen'
import * as GregorGen from '../gregor-gen'
import * as Chat2Gen from '../chat2-gen'
import * as Tabs from '../../constants/tabs'
import * as RouteTreeGen from '../route-tree-gen'
import * as mime from 'react-native-mime-types'
import * as Saga from '../../util/saga'
import TouchID from 'react-native-touch-id'
// this CANNOT be an import *, totally screws up the packager
import {
  NetInfo,
  AsyncStorage,
  Linking,
  NativeModules,
  ActionSheetIOS,
  CameraRoll,
  PermissionsAndroid,
  Clipboard,
} from 'react-native'
import {getPath} from '../../route-tree'
import RNFetchBlob from 'rn-fetch-blob'
import {isIOS, isAndroid} from '../../constants/platform'
import pushSaga, {getStartupDetailsFromInitialPush} from './push.native'

function showShareActionSheet(options: {
  url?: ?any,
  message?: ?any,
  mimeType?: ?string,
}): Promise<{completed: boolean, method: string}> {
  if (isIOS) {
    return new Promise((resolve, reject) =>
      ActionSheetIOS.showShareActionSheetWithOptions(options, reject, resolve)
    )
  } else {
    return NativeModules.ShareFiles.share(options.url, options.mimeType).then(
      () => ({completed: true, method: ''}),
      () => ({completed: false, method: ''})
    )
  }
}

type NextURI = string
function saveAttachmentDialog(filePath: string): Promise<NextURI> {
  let goodPath = filePath
  logger.debug('saveAttachment: ', goodPath)
  return CameraRoll.saveToCameraRoll(goodPath)
}

async function saveAttachmentToCameraRoll(fileURL: string, mimeType: string): Promise<void> {
  const logPrefix = '[saveAttachmentToCameraRoll] '
  const saveType = mimeType.startsWith('video') ? 'video' : 'photo'
  if (isIOS && saveType !== 'video') {
    // iOS cannot save a video from a URL, so we can only do images here. Fallback to temp file
    // method for videos.
    logger.info(logPrefix + 'Saving iOS picture to camera roll')
    await CameraRoll.saveToCameraRoll(fileURL)
    return
  }
  if (!isIOS) {
    const permissionStatus = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      {
        message: 'Keybase needs access to your storage so we can download an attachment.',
        title: 'Keybase Storage Permission',
      }
    )
    if (permissionStatus !== 'granted') {
      logger.error(logPrefix + 'Unable to acquire storage permissions')
      throw new Error('Unable to acquire storage permissions')
    }
  }
  const fetchURL = `${fileURL}&nostream=true`
  logger.info(logPrefix + `Fetching from URL: ${fetchURL}`)
  const download = await RNFetchBlob.config({
    appendExt: mime.extension(mimeType),
    fileCache: true,
  }).fetch('GET', fetchURL)
  logger.info(logPrefix + 'Fetching success, getting local file path')
  const path = download.path()
  logger.info(logPrefix + `Saving to ${path}`)
  try {
    logger.info(logPrefix + `Attempting to save as ${saveType}`)
    await CameraRoll.saveToCameraRoll(`file://${path}`, saveType)
    logger.info(logPrefix + 'Success')
  } catch (err) {
    logger.error(logPrefix + 'Failed:', err)
    throw err
  } finally {
    logger.info(logPrefix + 'Deleting tmp file')
    await RNFetchBlob.fs.unlink(path)
  }
}

// Downloads a file, shows the shareactionsheet, and deletes the file afterwards
function downloadAndShowShareActionSheet(fileURL: string, mimeType: string): Promise<void> {
  const extension = mime.extension(mimeType)
  return RNFetchBlob.config({appendExt: extension, fileCache: true})
    .fetch('GET', fileURL)
    .then(res => res.path())
    .then(path => Promise.all([showShareActionSheet({url: path}), Promise.resolve(path)]))
    .then(([_, path]) => RNFetchBlob.fs.unlink(path))
}

const openAppSettings = () => {
  if (isAndroid) {
    NativeModules.NativeSettings.open()
  } else {
    const settingsURL = 'app-settings:'
    Linking.canOpenURL(settingsURL).then(can => {
      if (can) {
        Linking.openURL(settingsURL)
      } else {
        logger.warn('Unable to open app settings')
      }
    })
  }
}

const getContentTypeFromURL = (
  url: string,
  cb: ({error?: any, statusCode?: number, contentType?: string}) => void
) =>
  // For some reason HEAD doesn't work on Android. So just GET one byte.
  // TODO: fix HEAD for Android and get rid of this hack.
  isAndroid
    ? fetch(url, {method: 'GET', headers: {Range: 'bytes=0-0'}}) // eslint-disable-line no-undef
        .then(response => {
          let contentType = ''
          let statusCode = response.status
          if (
            statusCode === 200 ||
            statusCode === 206 ||
            // 416 can happen if the file is empty.
            statusCode === 416
          ) {
            contentType = response.headers.get('Content-Type') || ''
            statusCode = 200 // Treat 200, 206, and 416 as 200.
          }
          cb({statusCode, contentType})
        })
        .catch(error => {
          console.log(error)
          cb({error})
        })
    : fetch(url, {method: 'HEAD'}) // eslint-disable-line no-undef
        .then(response => {
          let contentType = ''
          if (response.status === 200) {
            contentType = response.headers.get('Content-Type') || ''
          }
          cb({statusCode: response.status, contentType})
        })
        .catch(error => {
          console.log(error)
          cb({error})
        })

const updateChangedFocus = (action: ConfigGen.MobileAppStatePayload) => {
  let appFocused
  let logState
  switch (action.payload.nextAppState) {
    case 'active':
      appFocused = true
      logState = RPCTypes.appStateAppState.foreground
      break
    case 'background':
      appFocused = false
      logState = RPCTypes.appStateAppState.background
      break
    case 'inactive':
      appFocused = false
      logState = RPCTypes.appStateAppState.inactive
      break
    default:
      /*::
      declare var ifFlowErrorsHereItsCauseYouDidntHandleAllTypesAbove: (v: empty) => any
      ifFlowErrorsHereItsCauseYouDidntHandleAllTypesAbove(action.payload.nextAppState);
      */
      appFocused = false
      logState = RPCTypes.appStateAppState.foreground
  }

  logger.info(`setting app state on service to: ${logState}`)
  return Saga.put(ConfigGen.createChangedFocus({appFocused}))
}

const clearRouteState = () => Saga.call(AsyncStorage.removeItem, 'routeState')

const persistRouteState = (state: TypedState) => {
  const routePath = getPath(state.routeTree.routeState)
  const selectedTab = routePath.first()
  if (Tabs.isValidInitialTabString(selectedTab)) {
    const item = {
      // in a conversation and not on the inbox
      selectedConversationIDKey:
        selectedTab === Tabs.chatTab && routePath.size > 1 ? state.chat2.selectedConversation : null,
      tab: selectedTab,
    }

    return Saga.spawn(AsyncStorage.setItem, 'routeState', JSON.stringify(item))
  } else {
    return Saga.spawn(AsyncStorage.removeItem, 'routeState')
  }
}

const setupNetInfoWatcher = () =>
  Saga.call(function*() {
    const channel = Saga.eventChannel(emitter => {
      NetInfo.addEventListener('connectionChange', () => emitter('changed'))
      return () => {}
    }, Saga.buffers.dropping(1))
    while (true) {
      yield Saga.take(channel)
      yield Saga.put(GregorGen.createCheckReachability())
    }
  })

function* loadStartupDetails() {
  let startupWasFromPush = false
  let startupConversation = null
  let startupFollowUser = ''
  let startupLink = ''
  let startupTab = null

  const routeStateTask = yield Saga.fork(AsyncStorage.getItem, 'routeState')
  const linkTask = yield Saga.fork(Linking.getInitialURL)
  const initialPush = yield Saga.fork(getStartupDetailsFromInitialPush)
  const [routeState, link, push] = yield Saga.join(routeStateTask, linkTask, initialPush)

  // Top priority, push
  if (push) {
    startupWasFromPush = true
    startupConversation = push.startupConversation
    startupFollowUser = push.startupFollowUser
  }

  // Second priority, deep link
  if (!startupWasFromPush && link) {
    startupLink = link
  }

  // Third priority, saved from last session
  if (!startupWasFromPush && !startupLink && routeState) {
    try {
      const item = JSON.parse(routeState)
      if (item) {
        startupConversation = item.selectedConversationIDKey
        startupTab = item.tab
      }
    } catch (_) {
      startupConversation = null
      startupTab = null
    }
  }

  yield Saga.put(
    ConfigGen.createSetStartupDetails({
      startupConversation,
      startupFollowUser,
      startupLink,
      startupTab,
      startupWasFromPush,
    })
  )
}

const waitForStartupDetails = (state: TypedState, action: ConfigGen.DaemonHandshakePayload) => {
  // loadStartupDetails finished already
  if (state.config.startupDetailsLoaded) {
    return
  }
  // Else we have to wait for the loadStartupDetails to finish
  return Saga.call(function*() {
    yield Saga.put(
      ConfigGen.createDaemonHandshakeWait({
        increment: true,
        name: 'platform.native-waitStartupDetails',
        version: action.payload.version,
      })
    )
    yield Saga.take(ConfigGen.setStartupDetails)
    yield Saga.put(
      ConfigGen.createDaemonHandshakeWait({
        increment: false,
        name: 'platform.native-waitStartupDetails',
        version: action.payload.version,
      })
    )
  })
}

const copyToClipboard = (_: any, action: ConfigGen.CopyToClipboardPayload) => {
  Clipboard.setString(action.payload.text)
}

// Dont re-enter this logic
let inAskTouchID = false
let wasBackgrounded = true
const askTouchID = (state: TypedState, action) =>
  Saga.call(function*() {
    console.log('[TouchID]: checking', action.type)

    if (state.config.daemonHandshakeState !== 'done') {
      console.log('[TouchID]: still loading, bailing')
      inAskTouchID = false
      return
    }

    if (!state.config.touchIDAllowedBySystem || !state.config.touchIDEnabled) {
      console.log('[TouchID]: not enabled, bailing')
      wasBackgrounded = false
      inAskTouchID = false
      return
    }

    if (inAskTouchID) {
      console.log('[TouchID]: already working, bailing')
      return
    }

    inAskTouchID = true

    // only care if we're logged in
    if (!state.config.loggedIn) {
      console.log('[TouchID]: loggedout, bailing')
      inAskTouchID = false
      return
    }

    const appState = state.config.mobileAppState
    console.log('[TouchID]: current app state', appState)

    if (appState === 'background') {
      console.log('[TouchID]: background, bailing')
      yield Saga.put(ConfigGen.createTouchIDState({state: 'asking'}))
      wasBackgrounded = true
      inAskTouchID = false
      return
    }

    // opening app
    if (appState === 'active' && wasBackgrounded) {
      try {
        console.log('[TouchID]: active')
        yield Saga.put(ConfigGen.createTouchIDState({state: 'asking'}))
        yield Saga.call(() => TouchID.authenticate(`Authentication is required to gain access`))
        console.log('[TouchID]: active success')
        yield Saga.put(ConfigGen.createTouchIDState({state: 'done'}))
      } catch (e) {
        console.log('[TouchID]: active fail')
        console.log('[TouchID]: logging out')
        yield Saga.put(ConfigGen.createLogout())
        yield Saga.take(ConfigGen.loggedOut)
        yield Saga.put(ConfigGen.createTouchIDState({state: 'done'}))
      }
    }

    console.log('[TouchID]: checking done')
    wasBackgrounded = false
    inAskTouchID = false
  })

const loadTouchIDSettings = (_, action: ConfigGen.DaemonHandshakePayload) =>
  Saga.call(function*() {
    const loadTouchWaitKey = 'platform.specific.touchid'
    yield Saga.put(
      ConfigGen.createDaemonHandshakeWait({
        increment: true,
        name: loadTouchWaitKey,
        version: action.payload.version,
      })
    )
    const touchIDAllowedTask = yield Saga.fork(TouchID.isSupported)
    const touchIDEnabledTask = yield Saga.fork(() =>
      RPCTypes.configGetValueRpcPromise({path: 'ui.touchIDEnabled'}).catch(() => null)
    )
    const [touchIDAllowed, touchIDEnabledConfigValue] = yield Saga.join(
      touchIDAllowedTask,
      touchIDEnabledTask
    )

    const touchIDString = isAndroid ? (touchIDAllowed ? 'biometric sensor' : '') : touchIDAllowed
    const touchIDEnabled = !!(touchIDEnabledConfigValue && touchIDEnabledConfigValue.b)

    console.log(
      '[TouchID]: state allowed:',
      touchIDAllowed,
      ' enabled: ',
      touchIDEnabled,
      'enabled config value: ',
      touchIDEnabledConfigValue
    )
    yield Saga.put(ConfigGen.createTouchIDAllowedBySystem({allowed: touchIDString}))
    yield Saga.put(ConfigGen.createTouchIDEnabled({enabled: touchIDEnabled, writeToConfig: false}))

    yield Saga.put(
      ConfigGen.createDaemonHandshakeWait({
        increment: false,
        name: loadTouchWaitKey,
        version: action.payload.version,
      })
    )
  })

const saveTouchIDEnabled = (_, action: ConfigGen.TouchIDEnabledPayload) => {
  console.log('[TouchID]: saving pref', action.payload.enabled)
  return Saga.spawn(RPCTypes.configSetValueRpcPromise, {
    path: 'ui.touchIDEnabled',
    value: {b: action.payload.enabled, isNull: false},
  })
}

function* platformConfigSaga(): Saga.SagaGenerator<any, any> {
  yield Saga.actionToAction([ConfigGen.mobileAppState, ConfigGen.daemonHandshakeDone], askTouchID)
  yield Saga.actionToAction(ConfigGen.touchIDEnabled, saveTouchIDEnabled)
  yield Saga.safeTakeEveryPure(ConfigGen.mobileAppState, updateChangedFocus)
  yield Saga.actionToAction(ConfigGen.loggedOut, clearRouteState)
  yield Saga.actionToAction([RouteTreeGen.switchTo, Chat2Gen.selectConversation], persistRouteState)
  yield Saga.actionToAction(ConfigGen.openAppSettings, openAppSettings)
  yield Saga.actionToAction(ConfigGen.setupEngineListeners, setupNetInfoWatcher)
  yield Saga.actionToAction(ConfigGen.daemonHandshake, loadTouchIDSettings)
  yield Saga.actionToAction(ConfigGen.copyToClipboard, copyToClipboard)

  yield Saga.actionToAction(ConfigGen.daemonHandshake, waitForStartupDetails)
  // Start this immediately instead of waiting so we can do more things in parallel
  yield Saga.fork(loadStartupDetails)

  yield Saga.fork(pushSaga)
}

export {
  downloadAndShowShareActionSheet,
  saveAttachmentDialog,
  saveAttachmentToCameraRoll,
  showShareActionSheet,
  getContentTypeFromURL,
  platformConfigSaga,
}
