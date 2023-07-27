/* eslint-disable no-console */
import {PartnersURLs} from './urls.js'
import {AppInterface, isCurrentAppSchema} from '../../models/app/app.js'
import {OrganizationApp} from '../../models/organization.js'
import {getAppConfigurationShorthand} from '../../models/app/loader.js'
import {DevSessionDeleteMutation, DevSessionDeleteSchema} from '../../api/graphql/dev_session_delete.js'
import {partnersFqdn} from '@shopify/cli-kit/node/context/fqdn'
import {renderConcurrent, RenderConcurrentOptions, renderInfo} from '@shopify/cli-kit/node/ui'
import {openURL} from '@shopify/cli-kit/node/system'
import {basename} from '@shopify/cli-kit/node/path'
import {adminRequest} from '@shopify/cli-kit/node/api/admin'
import {AdminSession} from '@shopify/cli-kit/node/session'

export async function outputUpdateURLsResult(
  updated: boolean,
  urls: PartnersURLs,
  remoteApp: Omit<OrganizationApp, 'apiSecretKeys' | 'apiKey'> & {apiSecret?: string},
  localApp: AppInterface,
) {
  const dashboardURL = await partnersURL(remoteApp.organizationId, remoteApp.id)
  if (remoteApp.newApp) {
    renderInfo({
      headline: `For your convenience, we've given your app a default URL: ${urls.applicationUrl}.`,
      body: [
        "You can update your app's URL anytime in the",
        dashboardURL,
        'But once your app is live, updating its URL will disrupt user access.',
      ],
    })
  } else if (!updated) {
    if (isCurrentAppSchema(localApp.configuration)) {
      const fileName = basename(localApp.configurationPath)
      const configName = getAppConfigurationShorthand(fileName)
      renderInfo({
        body: [
          `To update URLs manually, add the following URLs to ${fileName} under auth > redirect_urls and run\n`,
          {
            command: `npm run shopify app config push -- --config=${configName}`,
          },
          '\n\n',
          {list: {items: urls.redirectUrlWhitelist}},
        ],
      })
    } else {
      renderInfo({
        body: [
          'To make URL updates manually, you can add the following URLs as redirects in your',
          dashboardURL,
          {char: ':'},
          '\n\n',
          {list: {items: urls.redirectUrlWhitelist}},
        ],
      })
    }
  }
}

export function renderDev(
  renderConcurrentOptions: RenderConcurrentOptions,
  previewUrl: string,
  adminSession?: AdminSession,
  ephemeralAppId?: string,
) {
  let options = renderConcurrentOptions

  if (previewUrl) {
    options = {
      ...options,
      onInput: (input, _key, exit) => {
        if (input === 'p' && previewUrl) {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          openURL(previewUrl)
        } else if (input === 'q') {
          if (typeof ephemeralAppId !== 'undefined' && typeof adminSession !== 'undefined') {
            deleteDevSession(adminSession, ephemeralAppId).catch((err) => {
              console.log(`Could not delete dev session. Error: ${err}`)
            })
          }
          exit()
        }
      },
      footer: {
        shortcuts: [
          {
            key: 'p',
            action: 'preview in your browser',
          },
          {
            key: 'q',
            action: 'quit',
          },
        ],
        subTitle: `Preview URL: ${previewUrl}`,
      },
    }
  }
  return renderConcurrent({...options, keepRunningAfterProcessesResolve: true})
}

async function partnersURL(organizationId: string, appId: string) {
  return {
    link: {
      label: 'Partners Dashboard',
      url: `https://${await partnersFqdn()}/${organizationId}/apps/${appId}/edit`,
    },
  }
}

async function deleteDevSession(adminSession: AdminSession, devSessionId: string) {
  // 1. delete the dev session via the Admin API
  console.log('Deleting dev session...')
  const devSessionDeleteResponse: DevSessionDeleteSchema = await adminRequest(DevSessionDeleteMutation, adminSession, {
    id: devSessionId,
  })

  // 2. handle errors in DevSessionDeleteSchema
  if (devSessionDeleteResponse.userErrors.length > 0) {
    console.log(devSessionDeleteResponse.userErrors)
  } else {
    console.log(`Successfully deleted dev with ID: ${devSessionId}`)
  }
}
