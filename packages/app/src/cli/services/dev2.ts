import {
  FrontendURLOptions,
  PartnersURLs,
  generateFrontendURL,
  generatePartnersURLs,
  getURLs,
  shouldOrPromptUpdateURLs,
  startTunnelPlugin,
  updateURLs,
} from './dev/urls.js'
import {DevOptions, logMetadataForDev, scopesMessage, setPreviousAppId, validateCustomPorts} from './dev.js'
import {ensureDevContext} from './context.js'
import {fetchSpecifications} from './generate/fetch-extension-specifications.js'
import {installAppDependencies} from './dependencies.js'
import {DevConfig, DevProcesses, setupDevProcesses} from './dev/processes/setup-dev-processes.js'
import {frontAndBackendConfig} from './dev/processes/utils.js'
import {outputUpdateURLsResult, renderDev} from './dev/ui.js'
import {DevProcessFunction} from './dev/processes/types.js'
import {canEnablePreviewMode} from './extensions/common.js'
import {mergeAppConfiguration} from './app/config/link.js'
import {rewriteConfiguration} from './app/write-app-configuration-file.js'
import {loadApp} from '../models/app/loader.js'
import {
  Web,
  isCurrentAppSchema,
  getAppScopesArray,
  AppInterface,
  CurrentAppConfiguration,
  AppSchema,
} from '../models/app/app.js'
import {getAppIdentifiers} from '../models/app/identifiers.js'
import {OrganizationApp} from '../models/organization.js'
import {AbortController} from '@shopify/cli-kit/node/abort'
import {ensureAuthenticatedPartners} from '@shopify/cli-kit/node/session'
import {getAvailableTCPPort} from '@shopify/cli-kit/node/tcp'
import {TunnelClient} from '@shopify/cli-kit/node/plugins/tunnel'
import {getBackendPort} from '@shopify/cli-kit/node/environment'
import {basename} from '@shopify/cli-kit/node/path'
import {renderConfirmationPrompt, renderWarning} from '@shopify/cli-kit/node/ui'
import {reportAnalyticsEvent} from '@shopify/cli-kit/node/analytics'
import {OutputProcess, formatPackageManagerCommand} from '@shopify/cli-kit/node/output'
import {deepDifference} from '@shopify/cli-kit/common/object'

export async function dev(commandOptions: DevOptions) {
  renderWarning({body: 'Running in new dev mode! Pass SHOPIFY_CLI_NEW_DEV=0 to run in old mode.'})
  const config = await prepareForDev(commandOptions)
  await actionsBeforeSettingUpDevProcesses(config)
  const {processes, previewUrl} = await setupDevProcesses(config)
  await actionsBeforeLaunchingDevProcesses(config)
  await launchDevProcesses({processes, previewUrl, config})
}

async function prepareForDev(commandOptions: DevOptions): Promise<DevConfig> {
  // Be optimistic about tunnel creation and do it as early as possible
  const tunnelPort = await getAvailableTCPPort()
  let tunnelClient: TunnelClient | undefined
  if (!commandOptions.tunnelUrl && !commandOptions.noTunnel) {
    tunnelClient = await startTunnelPlugin(commandOptions.commandConfig, tunnelPort, 'cloudflare')
  }

  const token = await ensureAuthenticatedPartners()
  const {
    storeFqdn,
    remoteApp,
    remoteAppUpdated,
    updateURLs: cachedUpdateURLs,
    configName,
  } = await ensureDevContext(commandOptions, token)

  const apiKey = remoteApp.apiKey
  const specifications = await fetchSpecifications({token, apiKey, config: commandOptions.commandConfig})
  let localApp = await loadApp({directory: commandOptions.directory, specifications, configName})

  function flattenObject(obj: {}) {
    const result: {[key: string]: {} | undefined} = {}

    function recurse(current?: {[key: string]: {[key: string]: {}}}, path = '') {
      for (const key in current) {
        const value = current[key]
        const newPath = path ? `${path}.${key}` : key

        // console.log({current, value}, typeof value === 'object', Boolean(value))
        if (typeof value === 'object' && Boolean(value)) {
          recurse(value, newPath)
        } else {
          result[newPath] = value
        }
      }
    }

    recurse(obj)

    return result
  }

  const checkForUnpushedChanges = async (
    localApp: CurrentAppConfiguration,
    remoteApp: Omit<OrganizationApp, 'apiSecretKeys'>,
  ) => {
    const remoteConfig = mergeAppConfiguration(localApp, remoteApp as OrganizationApp)
    const remote = rewriteConfiguration(AppSchema, remoteConfig) as {}
    const local = rewriteConfiguration(AppSchema, localApp) as {}

    const [upstreamConfig, localConfig] = deepDifference(remote, local)

    // @ts-ignore
    delete localConfig.build

    const flatUpstream = Object.entries(flattenObject(upstreamConfig))
    const flatLocal = Object.entries(flattenObject(localConfig))

    if (flatUpstream.length) {
      renderWarning({
        headline: 'You have unpushed changes to your configuration file',
        body: 'This could cause errors when installing and testing your app.',
      })

      await renderConfirmationPrompt({
        message: 'Push your local changes up to Shopify? These updates will go live immediately',
        gitDiff: {
          baselineContent: flatUpstream
            .map((tuple) => `${tuple[0].toString()}: ${tuple[1]!.toString()}`)
            .toString()
            .replaceAll(',', '\n'),
          updatedContent: flatLocal
            .map((tuple) => `${tuple[0].toString()}: ${tuple[1]!.toString()}`)
            .toString()
            .replaceAll(',', '\n'),
        },
        // infoTable: flatLocal.map((tuple, index) => {
        //   return {
        //     header: tuple[0]?.toString().replace('.', ' ').replace('_', ' ') ?? '',
        //     items: [`${flatUpstream[index]![1]} -> ${tuple[1]?.toString()}` ?? ''],
        //   }
        // }),
        confirmationMessage: 'Yes, push my changes now',
        cancellationMessage: 'No, I still need to update my configuration',
      })
    }

    // @ts-ignore
    console.log(flatUpstream, flatLocal)

    // console.log(deepDifference(flatUpstream, flatLocal))
    // console.log(flattenObject(localConfig))
  }

  if (isCurrentAppSchema(localApp.configuration)) {
    await checkForUnpushedChanges(localApp.configuration, remoteApp)
  }

  if (!commandOptions.skipDependenciesInstallation && !localApp.usesWorkspaces) {
    localApp = await installAppDependencies(localApp)
  }

  const {webs, ...network} = await setupNetworkingOptions(
    localApp.webs,
    apiKey,
    token,
    {
      noTunnel: commandOptions.noTunnel,
      commandConfig: commandOptions.commandConfig,
      tunnelUrl: commandOptions.tunnelUrl,
    },
    tunnelClient,
  )
  localApp.webs = webs

  const partnerUrlsUpdated = await handleUpdatingOfPartnerUrls(
    webs,
    commandOptions.update,
    network,
    localApp,
    cachedUpdateURLs,
    remoteApp,
    apiKey,
    token,
  )

  // If we have a real UUID for an extension, use that instead of a random one
  const allExtensionsWithDevUUIDs = getDevUUIDsForAllExtensions(localApp, apiKey)
  localApp.allExtensions = allExtensionsWithDevUUIDs

  return {
    storeFqdn,
    remoteApp,
    remoteAppUpdated,
    localApp,
    token,
    commandOptions,
    network,
    partnerUrlsUpdated,
    usesUnifiedDeployment: remoteApp?.betas?.unifiedAppDeployment ?? false,
  }
}

async function actionsBeforeSettingUpDevProcesses({localApp, remoteApp}: DevConfig) {
  if (
    isCurrentAppSchema(localApp.configuration) &&
    !localApp.configuration.access_scopes?.use_legacy_install_flow &&
    getAppScopesArray(localApp.configuration).sort().join(',') !== remoteApp.requestedAccessScopes?.sort().join(',')
  ) {
    const nextSteps = [
      [
        'Run',
        {command: formatPackageManagerCommand(localApp.packageManager, 'shopify app config push')},
        'to push your scopes to the Partner Dashboard',
      ],
    ]

    renderWarning({
      headline: [`The scopes in your TOML don't match the scopes in your Partner Dashboard`],
      body: [
        `Scopes in ${basename(localApp.configuration.path)}:`,
        scopesMessage(getAppScopesArray(localApp.configuration)),
        '\n',
        'Scopes in Partner Dashboard:',
        scopesMessage(remoteApp.requestedAccessScopes || []),
      ],
      nextSteps,
    })
  }
}

async function actionsBeforeLaunchingDevProcesses(config: DevConfig) {
  setPreviousAppId(config.commandOptions.directory, config.remoteApp.apiKey)

  await logMetadataForDev({
    devOptions: config.commandOptions,
    tunnelUrl: config.network.proxyUrl,
    shouldUpdateURLs: config.partnerUrlsUpdated,
    storeFqdn: config.storeFqdn,
    deploymentMode: config.usesUnifiedDeployment ? 'unified' : 'legacy',
  })

  await reportAnalyticsEvent({config: config.commandOptions.commandConfig})
}

function getDevUUIDsForAllExtensions(localApp: AppInterface, apiKey: string) {
  const prodEnvIdentifiers = getAppIdentifiers({app: localApp})
  const envExtensionsIds = prodEnvIdentifiers.extensions || {}
  const extensionsIds = prodEnvIdentifiers.app === apiKey ? envExtensionsIds : {}

  return localApp.allExtensions.map((ext) => {
    ext.devUUID = extensionsIds[ext.localIdentifier] ?? ext.devUUID
    return ext
  })
}

async function handleUpdatingOfPartnerUrls(
  webs: Web[],
  commandSpecifiedToUpdate: boolean,
  network: {
    proxyUrl: string
    currentUrls: PartnersURLs
  },
  localApp: AppInterface,
  cachedUpdateURLs: boolean | undefined,
  remoteApp: Omit<OrganizationApp, 'apiSecretKeys'> & {apiSecret?: string | undefined},
  apiKey: string,
  token: string,
) {
  const {backendConfig, frontendConfig} = frontAndBackendConfig(webs)
  let shouldUpdateURLs = false
  if (frontendConfig || backendConfig) {
    if (commandSpecifiedToUpdate) {
      const newURLs = generatePartnersURLs(
        network.proxyUrl,
        webs.map(({configuration}) => configuration.auth_callback_path).find((path) => path),
        isCurrentAppSchema(localApp.configuration) ? localApp.configuration.app_proxy : undefined,
      )
      shouldUpdateURLs = await shouldOrPromptUpdateURLs({
        currentURLs: network.currentUrls,
        appDirectory: localApp.directory,
        cachedUpdateURLs,
        newApp: remoteApp.newApp,
        localApp,
        apiKey,
      })
      if (shouldUpdateURLs) await updateURLs(newURLs, apiKey, token, localApp)
      await outputUpdateURLsResult(shouldUpdateURLs, newURLs, remoteApp, localApp)
    }
  }
  return shouldUpdateURLs
}

async function setupNetworkingOptions(
  webs: Web[],
  apiKey: string,
  token: string,
  frontEndOptions: Pick<FrontendURLOptions, 'noTunnel' | 'tunnelUrl' | 'commandConfig'>,
  tunnelClient?: TunnelClient,
) {
  const {backendConfig, frontendConfig} = frontAndBackendConfig(webs)

  await validateCustomPorts(webs)

  // generateFrontendURL still uses the old naming of frontendUrl and frontendPort,
  // we can rename them to proxyUrl and proxyPort when we delete dev.ts
  const [{frontendUrl, frontendPort: proxyPort, usingLocalhost}, backendPort, currentUrls] = await Promise.all([
    generateFrontendURL({
      ...frontEndOptions,
      tunnelClient,
    }),
    getBackendPort() || backendConfig?.configuration.port || getAvailableTCPPort(),
    getURLs(apiKey, token),
  ])
  const proxyUrl = usingLocalhost ? `${frontendUrl}:${proxyPort}` : frontendUrl

  let frontendPort = frontendConfig?.configuration.port
  if (frontendConfig) {
    if (!frontendPort) {
      frontendPort = frontendConfig === backendConfig ? backendPort : await getAvailableTCPPort()
    }
    frontendConfig.configuration.port = frontendPort
  }
  frontendPort = frontendPort ?? (await getAvailableTCPPort())

  return {
    proxyUrl,
    proxyPort,
    frontendPort,
    backendPort,
    currentUrls,
    webs,
  }
}

async function launchDevProcesses({
  processes,
  previewUrl,
  config,
}: {
  processes: DevProcesses
  previewUrl: string
  config: DevConfig
}) {
  const abortController = new AbortController()
  const processesForTaskRunner: OutputProcess[] = processes.map((process) => {
    const outputProcess: OutputProcess = {
      prefix: process.prefix,
      action: async (stdout, stderr, signal) => {
        const fn = process.function as DevProcessFunction<typeof process.options>
        return fn({stdout, stderr, abortSignal: signal}, process.options)
      },
    }
    return outputProcess
  })

  const app = {
    canEnablePreviewMode: canEnablePreviewMode(config.remoteApp, config.localApp),
    developmentStorePreviewEnabled: config.remoteApp.developmentStorePreviewEnabled,
    apiKey: config.remoteApp.apiKey,
    token: config.token,
  }

  return renderDev({
    processes: processesForTaskRunner,
    previewUrl,
    app,
    abortController,
  })
}
