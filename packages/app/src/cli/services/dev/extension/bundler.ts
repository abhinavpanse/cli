import {ExtensionsPayloadStore} from './payload/store.js'
import {ExtensionDevOptions} from '../extension.js'
import {bundleExtension} from '../../extensions/bundle.js'

import {AppInterface} from '../../../models/app/app.js'
import {updateExtensionConfig, updateExtensionDraft} from '../update-extension.js'
import {buildFunctionExtension} from '../../../services/build/extension.js'
import {ExtensionInstance} from '../../../models/extensions/extension-instance.js'
import {DevSessionDeleteAppModulesMutation} from '../../../api/graphql/dev_session_delete_app_modules.js'
import {AbortController, AbortSignal} from '@shopify/cli-kit/node/abort'
import {joinPath} from '@shopify/cli-kit/node/path'
import {outputDebug, outputInfo, outputWarn} from '@shopify/cli-kit/node/output'
import {AdminSession} from '@shopify/cli-kit/node/session'
import {adminRequest} from '@shopify/cli-kit/node/api/admin'
import {Writable} from 'stream'

export interface WatchEvent {
  path: string
  type: 'build' | 'localization'
}

export interface FileWatcherOptions {
  devOptions: ExtensionDevOptions
  payloadStore: ExtensionsPayloadStore
}

export interface FileWatcher {
  close: () => void
}

export async function setupBundlerAndFileWatcher(options: FileWatcherOptions) {
  const {default: chokidar} = await import('chokidar')
  const abortController = new AbortController()

  const bundlers: Promise<void>[] = []

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  options.devOptions.extensions.forEach(async (extension) => {
    bundlers.push(
      bundleExtension({
        minify: false,
        outputPath: extension.outputPath,
        environment: 'development',
        env: {
          ...(options.devOptions.app.dotenv?.variables ?? {}),
          APP_URL: options.devOptions.url,
        },
        stdin: {
          contents: extension.getBundleExtensionStdinContent(),
          resolveDir: extension.directory,
          loader: 'tsx',
        },
        stderr: options.devOptions.stderr,
        stdout: options.devOptions.stdout,
        watchSignal: abortController.signal,
        watch: async (result) => {
          const error = (result?.errors?.length ?? 0) > 0
          outputDebug(
            `The Javascript bundle of the UI extension with ID ${extension.devUUID} has ${
              error ? 'an error' : 'changed'
            }`,
            error ? options.devOptions.stderr : options.devOptions.stdout,
          )

          try {
            await options.payloadStore.updateExtension(extension, options.devOptions, {
              status: error ? 'error' : 'success',
            })
            // eslint-disable-next-line no-catch-all/no-catch-all
          } catch {
            // ESBuild handles error output
          }
        },
      }),
    )

    const localeWatcher = chokidar
      .watch(joinPath(extension.directory, 'locales', '**.json'))
      .on('change', (_event, path) => {
        outputDebug(`Locale file at path ${path} changed`, options.devOptions.stdout)
        options.payloadStore
          .updateExtension(extension, options.devOptions)
          .then((_closed) => {
            outputDebug(`Notified extension ${extension.devUUID} about the locale change.`, options.devOptions.stdout)
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .catch((_: any) => {})
      })

    abortController.signal.addEventListener('abort', () => {
      outputDebug(`Closing locale file watching for extension with ID ${extension.devUUID}`, options.devOptions.stdout)
      localeWatcher
        .close()
        .then(() => {
          outputDebug(`Locale file watching closed for extension with ${extension.devUUID}`, options.devOptions.stdout)
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .catch((error: any) => {
          outputDebug(
            `Locale file watching failed to close for extension with ${extension.devUUID}: ${error.message}`,
            options.devOptions.stderr,
          )
        })
    })
  })

  await Promise.all(bundlers)

  return {
    close: () => {
      abortController.abort()
    },
  }
}

interface SetupDraftableExtensionBundlerOptions {
  extension: ExtensionInstance
  app: AppInterface
  url: string
  token: string
  adminSession: AdminSession
  apiKey: string
  registrationId: string
  stderr: Writable
  stdout: Writable
  signal: AbortSignal
  unifiedDeployment: boolean
}

export async function setupDraftableExtensionBundler({
  extension,
  app,
  url,
  token,
  adminSession,
  apiKey,
  registrationId,
  stderr,
  stdout,
  signal,
  unifiedDeployment,
}: SetupDraftableExtensionBundlerOptions) {
  const {default: chokidar} = await import('chokidar')

  const configWatcher = chokidar.watch(extension.directory).on('change', (path, stats) => {
    if (path.includes('extension.toml')) return
    outputInfo(`File change detected: ${path}`, stdout)
    outputInfo(`Change detected for ${extension.handle}`, stdout)
    updateExtensionConfig({
      app,
      extension,
      token,
      adminSession,
      apiKey,
      registrationId,
      stdout,
      stderr,
      unifiedDeployment,
    }).catch((_: unknown) => {})
  })

  signal.addEventListener('abort', () => {
    outputDebug(`Closing file watching for ${extension.handle}`, stdout)

    configWatcher
      .close()
      .then(() => {
        outputDebug(`File watching closed for ${extension.handle}`, stdout)
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .catch((error: any) => {
        outputDebug(`File watching failed to close for ${extension.handle}: ${error.message}`, stderr)
      })
  })
}

interface SetupConfigWatcherOptions {
  app: AppInterface
  extension: ExtensionInstance
  token: string
  adminSession: AdminSession
  apiKey: string
  registrationId: string
  stdout: Writable
  stderr: Writable
  signal: AbortSignal
  unifiedDeployment: boolean
}

export async function setupConfigWatcher({
  app,
  extension,
  token,
  adminSession,
  apiKey,
  registrationId,
  stdout,
  stderr,
  signal,
  unifiedDeployment,
}: SetupConfigWatcherOptions) {
  const {default: chokidar} = await import('chokidar')

  const deletionWatcher = chokidar.watch(extension.directory).on('unlinkDir', (path) => {
    if (path === extension.directory) {
      outputInfo(`Deleting extension ${extension.handle}`, stdout)
      adminRequest(DevSessionDeleteAppModulesMutation, adminSession, {apiKey, moduleUuidsToDelete: [extension.handle]})
        .then((result: unknown) => {
          console.log(result)
          outputInfo(`Deleted extension ${extension.handle}`, stdout)
        })

        .catch((error: unknown) => {
          console.log(error)
          outputInfo(`Failed to delete extension ${extension.handle}`, stdout)
        })
    }
  })

  const configWatcher = chokidar.watch(extension.configurationPath).on('change', (path, stats) => {
    outputInfo(`Event detected ${path}`)
    outputInfo(`Config file at path ${extension.configurationPath} changed`, stdout)
    updateExtensionConfig({
      app,
      extension,
      token,
      adminSession,
      apiKey,
      registrationId,
      stdout,
      stderr,
      unifiedDeployment,
    }).catch((_: unknown) => {})
  })

  signal.addEventListener('abort', () => {
    outputDebug(`Closing config file watching for extension with ID ${extension.devUUID}`, stdout)
    deletionWatcher
      .close()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .catch((error: any) => {
        outputDebug(
          `Config file watching failed to close for extension with ${extension.devUUID}: ${error.message}`,
          stderr,
        )
      })
    configWatcher
      .close()
      .then(() => {
        outputDebug(`Config file watching closed for extension with ${extension.devUUID}`, stdout)
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .catch((error: any) => {
        outputDebug(
          `Config file watching failed to close for extension with ${extension.devUUID}: ${error.message}`,
          stderr,
        )
      })
  })
}

export interface SetupFunctionWatcherOptions {
  extension: ExtensionInstance
  app: AppInterface
  stdout: Writable
  stderr: Writable
  signal: AbortSignal
  token: string
  apiKey: string
  registrationId: string
  unifiedDeployment: boolean
}

export async function setupFunctionWatcher({
  extension,
  app,
  stdout,
  stderr,
  signal,
  token,
  apiKey,
  registrationId,
  unifiedDeployment,
}: SetupFunctionWatcherOptions) {
  const {default: chokidar} = await import('chokidar')

  outputDebug(`Starting watcher for function extension ${extension.devUUID}`, stdout)
  const watchPaths = extension.watchPaths
  if (!watchPaths) {
    outputWarn(
      `Function extension ${extension.localIdentifier} is missing the 'build.watch' setting, automatic builds are disabled.`,
      stdout,
    )
    return
  }

  outputDebug(`Watching paths for function extension ${extension.localIdentifier}: ${watchPaths}`, stdout)
  let buildController: AbortController | null

  const functionWatcher = chokidar.watch(watchPaths).on('change', (path) => {
    outputDebug(`Function extension file at path ${path} changed`, stdout)
    if (buildController) {
      // terminate any existing builds
      buildController.abort()
    }
    buildController = new AbortController()
    const buildSignal = buildController.signal
    buildFunctionExtension(extension, {
      app,
      stdout,
      stderr,
      useTasks: false,
      signal: buildSignal,
    })
      .then(() => {
        if (!buildSignal.aborted) {
          return updateExtensionDraft({extension, token, apiKey, registrationId, stdout, stderr, unifiedDeployment})
        }
      })
      .catch((updateError: unknown) => {
        outputWarn(`Error while deploying updated extension draft: ${JSON.stringify(updateError, null, 2)}`, stdout)
      })
  })

  signal.addEventListener('abort', () => {
    outputDebug(`Closing function file watching for extension with ID ${extension.devUUID}`, stdout)
    functionWatcher
      .close()
      .then(() => {
        outputDebug(`Function file watching closed for extension with ${extension.devUUID}`, stdout)
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .catch((error: any) => {
        outputDebug(
          `Function file watching failed to close for extension with ${extension.devUUID}: ${error.message}`,
          stderr,
        )
      })
  })
}
